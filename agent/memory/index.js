/**
 * Agent Memory System — Four-Tier Memory
 * 
 * 1. Episodic  — current-run state (what happened this session)
 * 2. Semantic  — Pinecone vector store (company knowledge, tender concepts)
 * 3. Procedural — Redis key-value (site-specific tactics the agent learned)
 * 4. Outcome  — MongoDB (feedback loops: interested/won/lost)
 * 
 * The procedural memory is what makes the agent a "driver not a passenger."
 * When it learns "site X always has tenders under Archive > Annual Tenders",
 * it remembers that and goes directly there next time.
 */

const { createClient } = require('redis');
const { logger } = require('../utils/logger');
const { Pinecone } = require('@pinecone-database/pinecone');

let redisClient = null;

async function getRedis() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    await redisClient.connect();
  }
  return redisClient;
}

class AgentMemory {
  constructor() {
    this.pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }

  // ==================== PROCEDURAL MEMORY (Redis) ====================
  // "I know how to navigate site X" — tactical site knowledge

  async getDomainKnowledge(domain) {
    try {
      const redis = await getRedis();
      const data = await redis.get(`domain:${domain}`);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      logger.warn(`Memory read failed for ${domain}: ${e.message}`);
      return null;
    }
  }

  async saveDomainKnowledge(domain, knowledge) {
    try {
      const redis = await getRedis();
      const existing = await this.getDomainKnowledge(domain) || {};
      const merged = { ...existing, ...knowledge, lastUpdated: new Date().toISOString() };
      await redis.setEx(`domain:${domain}`, 30 * 24 * 3600, JSON.stringify(merged)); // 30 day TTL
      logger.info(`  💾 Domain memory saved: ${domain}`);
    } catch (e) {
      logger.warn(`Memory write failed: ${e.message}`);
    }
  }

  /**
   * Save a "behavioral pattern" — how to handle a specific site quirk
   * Called when human admin corrects the agent
   */
  async saveBehavioralPattern(domain, situation, solution) {
    try {
      const redis = await getRedis();
      const key = `pattern:${domain}`;
      const existing = JSON.parse(await redis.get(key) || '[]');
      existing.push({ situation, solution, savedAt: new Date().toISOString() });
      await redis.set(key, JSON.stringify(existing.slice(-20))); // Keep last 20 patterns
      logger.info(`  🧠 Behavioral pattern saved for ${domain}: "${situation}"`);
    } catch (e) {
      logger.warn(`Pattern save failed: ${e.message}`);
    }
  }

  async getBehavioralPatterns(domain) {
    try {
      const redis = await getRedis();
      const data = await redis.get(`pattern:${domain}`);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  // ==================== EPISODIC MEMORY (in-run) ====================

  async saveEpisode(episodicMemory) {
    try {
      const redis = await getRedis();
      const key = `episode:${episodicMemory.goalId}`;
      await redis.setEx(key, 7 * 24 * 3600, JSON.stringify({
        ...episodicMemory,
        screenshot: '[omitted]', // Don't store screenshots in Redis
        completedAt: new Date().toISOString()
      }));
    } catch (e) {
      logger.warn(`Episode save failed: ${e.message}`);
    }
  }

  // ==================== OUTCOME MEMORY (MongoDB via Mongoose) ====================
  // Tracks user feedback: interested/won/lost — trains the agent over time

  async recordOutcome(companyId, tenderId, outcome, details = {}) {
    try {
      const { Company } = require('../../backend/models');
      await Company.findByIdAndUpdate(companyId, {
        $push: {
          feedback: {
            tenderId,
            action: outcome,
            ...details,
            timestamp: new Date()
          }
        }
      });

      // Update Redis cache for fast access
      const redis = await getRedis();
      const key = `company_prefs:${companyId}`;
      const prefs = JSON.parse(await redis.get(key) || '{}');

      if (outcome === 'interested' || outcome === 'won') {
        prefs.positiveSignals = (prefs.positiveSignals || []);
        prefs.positiveSignals.push(details);
        prefs.positiveSignals = prefs.positiveSignals.slice(-50);
      } else if (outcome === 'not_relevant') {
        prefs.negativeSignals = (prefs.negativeSignals || []);
        prefs.negativeSignals.push(details);
      }

      await redis.setEx(key, 24 * 3600, JSON.stringify(prefs));
      logger.info(`  📊 Outcome recorded: ${outcome} for company ${companyId}`);
    } catch (e) {
      logger.warn(`Outcome record failed: ${e.message}`);
    }
  }

  async getCompanyPreferences(companyId) {
    try {
      const redis = await getRedis();
      const cached = await redis.get(`company_prefs:${companyId}`);
      if (cached) return JSON.parse(cached);

      // Fall back to MongoDB
      const { Company } = require('../../backend/models');
      const company = await Company.findById(companyId).select('feedback tenderPreferences industry services');
      return { feedback: company?.feedback || [], preferences: company?.tenderPreferences || {} };
    } catch (e) {
      return {};
    }
  }

  // ==================== SEMANTIC MEMORY (Pinecone) ====================
  // Company knowledge base — capability statements, past bids, certs

  async semanticSearch(companyId, query, topK = 5) {
    try {
      const index = this.pinecone.Index(process.env.PINECONE_INDEX_NAME || 'tenderpro-vectors');
      const namespace = `company-${companyId}`;

      // Get query embedding
      const OpenAI = require('openai').default;
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const embResponse = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: query.substring(0, 8000)
      });

      const results = await index.namespace(namespace).query({
        vector: embResponse.data[0].embedding,
        topK,
        includeMetadata: true
      });

      return results.matches
        .filter(m => m.score > 0.5)
        .map(m => ({ content: m.metadata?.content, score: m.score, type: m.metadata?.documentType }));
    } catch (e) {
      logger.warn(`Semantic search failed: ${e.message}`);
      return [];
    }
  }

  // ==================== WORKING MEMORY (Agent State) ====================
  // Short-term state during a single browsing session

  async getWorkingMemory(sessionId) {
    try {
      const redis = await getRedis();
      const data = await redis.get(`working:${sessionId}`);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      return {};
    }
  }

  async updateWorkingMemory(sessionId, updates) {
    try {
      const redis = await getRedis();
      const existing = await this.getWorkingMemory(sessionId);
      const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      await redis.setEx(`working:${sessionId}`, 3600, JSON.stringify(merged)); // 1 hour TTL
    } catch (e) {}
  }
}

module.exports = { AgentMemory };
