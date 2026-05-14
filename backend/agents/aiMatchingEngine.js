/**
 * AI Matching Engine (v2)
 *
 * Upgrades:
 *  ✓ GoNoGoSchema Zod validation (no more regex JSON cleaning)
 *  ✓ WinProbabilityEngine integrated into every match
 *  ✓ Shadow-mode cross-validation on match score
 *  ✓ Prompt caching on long system prompt
 *  ✓ VoiceCommandSchema validation
 *  ✓ Model fallback chain via llmClient
 */

const { Pinecone }         = require('@pinecone-database/pinecone');
const OpenAI               = require('openai').default;
const { Company, Tender }  = require('../models');
const { logger }           = require('../utils/logger');
const { translateText, getExchangeRate } = require('../services/translationService');
const { callAnthropic, shadowCall } = require('../../agent/core/llmClient');
const { GoNoGoSchema, VoiceCommandSchema, parseLLMOutput } = require('../../agent/core/schemas');
const { WinProbabilityEngine } = require('../../agent/core/winProbability');

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const winEngine = new WinProbabilityEngine();

const GONO_SYSTEM = `You are an expert tender analyst with deep global procurement knowledge.
Analyse the tender against the company profile. Return a precise Go/No-Go assessment.
Respond ONLY with valid JSON — no markdown, no comments.`;

class AIMatchingEngine {
  constructor() {
    this.index = pinecone.Index(process.env.PINECONE_INDEX_NAME || 'tenderpro-vectors');
  }

  // ── Primary match function ────────────────────────────────────────────────
  async matchTenderToCompany(tender, company) {
    try {
      // 1. Vector similarity search against company knowledge base
      const namespace  = company.knowledgeBase?.vectorNamespace || `company-${company._id}`;
      const tenderText = buildTenderText(tender);
      const embedding  = await this._embed(tenderText);

      const queryResult = await this.index.namespace(namespace).query({
        vector: embedding, topK: 5, includeMetadata: true
      });
      const ragDocs    = queryResult.matches || [];
      const avgSimilarity = ragDocs.length
        ? ragDocs.reduce((s, m) => s + m.score, 0) / ragDocs.length
        : 0;

      // 2. Shadow Go/No-Go analysis (two models, flag conflicts)
      const companyContext = buildCompanyContext(company, ragDocs);
      const gonogo = await this._shadowGoNoGo(tender, company, companyContext, avgSimilarity);

      // 3. Win-probability (only for "go" or "review" to save cost)
      let winProb = null;
      if (gonogo.data.goNoGo !== 'no_go') {
        winProb = await winEngine.analyse(tender, company, ragDocs.map(r => r.metadata || {}))
          .catch(() => null);
      }

      // 4. Normalise financials
      const normalizedFinancials = await this._normaliseFinancials(
        tender.financials, company.tenderPreferences?.currency || 'USD'
      );

      // 5. Competitor intelligence
      const competitorInsight = getCompetitorInsight(tender, company);

      return {
        matchScore:          gonogo.data.matchScore,
        confidenceScore:     Math.round(avgSimilarity * 100),
        reasoning:           gonogo.data.reasoning,
        analysis: {
          strengths:         gonogo.data.strengths,
          risks:             gonogo.data.risks,
          dealBreakers:      gonogo.data.dealBreakers,
          recommendations:   gonogo.data.recommendations,
          goNoGo:            gonogo.data.goNoGo,
          pastSimilarBid:    gonogo.data.pastSimilarBid,
          timelineRisk:      gonogo.data.timelineRisk,
          budgetAlignment:   gonogo.data.budgetAlignment
        },
        winProbability:      winProb,
        competitorInsight,
        normalizedFinancials,
        shadowConflicts:     gonogo.conflicts,
        requiresReview:      gonogo.requiresReview
      };
    } catch (error) {
      logger.error('Matching engine error:', error.message);
      return this._fallbackMatch(tender, company);
    }
  }

  // ── Shadow Go/No-Go ───────────────────────────────────────────────────────
  async _shadowGoNoGo(tender, company, companyContext, similarityScore) {
    const prompt = buildGoNoGoPrompt(tender, companyContext);

    const result = await shadowCall({
      system:      GONO_SYSTEM,
      messages:    [{ role: 'user', content: prompt }],
      schema:      GoNoGoSchema,
      fallback:    fallbackGoNoGo(similarityScore),
      watchFields: ['matchScore', 'goNoGo']
    });

    if (result.requiresReview) {
      logger.warn(`  ⚠️  Go/No-Go shadow conflict: ${result.conflicts.map(c => c.field).join(', ')}`);
    }

    return result;
  }

  // ── Proposal drafter ──────────────────────────────────────────────────────
  async generateProposalDraft(tender, company, match) {
    const prompt = `You are an expert bid writer. Create a 60% complete proposal draft.

COMPANY:
${buildCompanyContext(company, [])}

TENDER:
Title: ${tender.title}
Description: ${(tender.description || '').substring(0, 3000)}
Requirements: ${(tender.requirements?.eligibility || []).join('; ')}
Value: ${tender.financials?.currency} ${tender.financials?.estimatedValue?.toLocaleString() || 'TBD'}
Deadline: ${tender.dates?.closingDate}
Win probability: ${match?.winProbability?.probability || 'N/A'}%

Produce a professional proposal with:
1. Executive Summary (3 paragraphs)
2. Technical Approach & Methodology
3. Team Composition
4. Past Performance (reference company data)
5. Financial Proposal Framework
6. Compliance Statement

Use [PLACEHOLDER] where company-specific data is needed. Format with clear headings.`;

    return callAnthropic({
      system: 'You are an expert proposal writer for global procurement bids.',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 4000,
      preferModel: 'opus',
      useCache: true
    });
  }

  // ── Voice command parser ──────────────────────────────────────────────────
  async processVoiceCommand(transcription, company) {
    const raw = await callAnthropic({
      system: 'Extract tender search parameters from a voice command. Respond ONLY with valid JSON.',
      messages: [{
        role: 'user',
        content: `Voice command: "${transcription}"\n\nExtract and return JSON:\n{"intent":"search","sector":null,"country":null,"region":null,"timeframe":null,"tenderType":null,"minBudget":null,"maxBudget":null,"keywords":[]}`
      }],
      maxTokens: 300,
      preferModel: 'haiku',
      useCache: true
    });

    const { data } = parseLLMOutput(VoiceCommandSchema, raw, { intent: 'search', keywords: [] });
    return data;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  async _embed(text) {
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-large',
      input: text.substring(0, 8000)
    });
    return res.data[0].embedding;
  }

  async _normaliseFinancials(financials, targetCurrency) {
    if (!financials?.estimatedValue) return financials;
    try {
      const rate = await getExchangeRate(financials.currency, targetCurrency);
      return { ...financials, normalizedValue: financials.estimatedValue * rate, normalizedCurrency: targetCurrency, exchangeRate: rate };
    } catch { return financials; }
  }

  _fallbackMatch(tender, company) {
    const overlap = (company.services || []).join(' ').toLowerCase();
    const text    = `${tender.title} ${tender.description || ''}`.toLowerCase();
    const hits    = overlap.split(' ').filter(w => w.length > 3 && text.includes(w)).length;
    const score   = Math.min(60, hits * 10);
    return {
      matchScore: score, confidenceScore: 25,
      reasoning: 'Keyword-based fallback match. LLM analysis unavailable.',
      analysis: { strengths: [], risks: [], dealBreakers: [], recommendations: [], goNoGo: score > 50 ? 'review' : 'no_go', pastSimilarBid: null },
      winProbability: null, competitorInsight: null
    };
  }
}

// ── Pure helpers (no class state needed) ─────────────────────────────────────
function buildTenderText(tender) {
  return [
    tender.title,
    tender.description || '',
    tender.fullDescription || '',
    ...(tender.requirements?.eligibility || []),
    tender.sector || '',
    tender.category || ''
  ].join(' ').substring(0, 6000);
}

function buildCompanyContext(company, ragDocs) {
  const docs = ragDocs.map(d => `- ${d.metadata?.content || ''}`).join('\n');
  return `COMPANY: ${company.name}
Services: ${(company.services || []).join(', ')}
Sectors: ${(company.industry || []).join(', ')}
Certs: ${(company.certifications || []).map(c => c.name).join(', ')}
Past bids:
${(company.pastBids || []).slice(0, 5).map(b => `  ${b.tenderTitle} (${b.country},${b.year}): ${b.won ? 'WON' : 'Lost'}, ${b.currency}${b.value?.toLocaleString()}`).join('\n')}
Knowledge base excerpts:
${docs || 'None indexed yet'}`;
}

function buildGoNoGoPrompt(tender, companyContext) {
  return `${companyContext}

TENDER:
Title: ${tender.title}
Sector: ${tender.sector}
Location: ${tender.location?.country}, ${tender.location?.region || ''}
Value: ${tender.financials?.currency} ${tender.financials?.estimatedValue?.toLocaleString() || 'undisclosed'}
Deadline: ${tender.dates?.closingDate ? new Date(tender.dates.closingDate).toDateString() : 'unknown'}
Requirements: ${(tender.requirements?.eligibility || []).join('; ')}
Certs required: ${(tender.requirements?.certifications || []).join(', ') || 'none'}
Experience: ${tender.requirements?.experience || 'not specified'}
Local content: ${tender.requirements?.localContentRequirement || 'none'}
ESG: ${tender.requirements?.esgRequirements || 'none'}
Description: ${(tender.description || '').substring(0, 1500)}

Respond ONLY with JSON:
{"matchScore":75,"goNoGo":"go","reasoning":"...","strengths":["..."],"risks":["..."],"dealBreakers":[],"recommendations":["..."],"pastSimilarBid":{"title":null,"won":null,"year":null,"value":null},"timelineRisk":"low","budgetAlignment":"within_budget"}`;
}

function fallbackGoNoGo(similarity) {
  const score = Math.round(similarity * 100);
  return {
    matchScore: score,
    goNoGo: score > 70 ? 'go' : score > 40 ? 'review' : 'no_go',
    reasoning: 'Automated match based on profile similarity. LLM analysis failed.',
    strengths: [], risks: [], dealBreakers: [], recommendations: [], pastSimilarBid: null
  };
}

function getCompetitorInsight(tender, company) {
  const competitors = (company.competitorIntelligence || []).filter(
    c => c.country === tender.location?.country && c.sector === tender.sector
  );
  if (!competitors.length) return null;
  const sorted = competitors.sort((a, b) => b.tendersWon - a.tendersWon);
  return {
    usualWinners: sorted.slice(0, 3).map(c => ({ name: c.competitorName, avgBid: c.avgWinAmount, currency: c.currency, wins: c.tendersWon })),
    pricePoint: { avg: sorted.reduce((s, c) => s + c.avgWinAmount, 0) / sorted.length, currency: sorted[0]?.currency }
  };
}

module.exports = { AIMatchingEngine };
