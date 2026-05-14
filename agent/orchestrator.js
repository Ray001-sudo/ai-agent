/**
 * Agent Orchestrator — Cost-Efficient Scheduling (v3)
 *
 * Credit-budget strategy:
 *  ✓ Every scouting round  → verified portals first ($0 search credits)
 *  ✓ Weekly cap            → DiscoveryModule runs ONCE per week only
 *  ✓ Cron schedule         → every 6h (SCRAPE_INTERVAL_HOURS)
 *  ✓ Human-in-loop         → admin WhatsApp on 5-strategy failure
 */

require('dotenv').config();
const cron                    = require('node-cron');
const { TenderAgentCore }     = require('./core/agentLoop');
const { Tender, Company, TenderMatch } = require('../backend/models');
const { logger }              = require('./utils/logger');
const { sendWhatsAppMessage } = require('../backend/whatsapp/whatsAppClient');
const { AIMatchingEngine }    = require('../backend/agents/aiMatchingEngine');
const { AgentMemory }         = require('./memory');
const { getRedisClient }      = require('../backend/utils/redis');

const matchingEngine = new AIMatchingEngine();
const agentMemory    = new AgentMemory();

const LAST_DISCOVERY_KEY   = 'orchestrator:last_discovery_run';
const DISCOVERY_WEEKLY_TTL = 7 * 24 * 3600;

class AgentOrchestrator {
  constructor(io) {
    this.io        = io;
    this.isRunning = false;
    this.agent     = new TenderAgentCore({
      onHumanNeeded: this._handleHumanFallback.bind(this),
      onTenderFound: this._handleTenderFound.bind(this)
    });
  }

  async runScoutingRound() {
    if (this.isRunning) { logger.info('Scout round already running — skipping'); return; }
    this.isRunning = true;
    const t0 = Date.now();
    logger.info('🌍 Scouting round started (verified portals only)');
    try {
      const companies = await Company.find({ plan: { $ne: 'inactive' } }).limit(100);
      for (const c of companies) await this._scoutForCompany(c, false);
      const elapsed = Math.round((Date.now() - t0) / 1000);
      logger.info(`✅ Scouting round done in ${elapsed}s`);
      if (this.io) this.io.emit('scouting:complete', { elapsed, companies: companies.length });
    } catch (err) {
      logger.error('Scouting error:', err.message);
    } finally { this.isRunning = false; }
  }

  async runWeeklyDiscovery() {
    try {
      const redis = getRedisClient();
      const last  = await redis.get(LAST_DISCOVERY_KEY).catch(() => null);
      if (last) { logger.info('⏭️  Weekly discovery already ran — skipping'); return; }

      logger.info('🔭 Weekly discovery — searching for NEW portals');
      const companies = await Company.find({ plan: { $ne: 'inactive' } }).limit(20);
      for (const c of companies) await this._scoutForCompany(c, true);

      await redis.setEx(LAST_DISCOVERY_KEY, DISCOVERY_WEEKLY_TTL, new Date().toISOString());
      logger.info('🔭 Weekly discovery complete — locked for 7 days');
    } catch (err) {
      logger.error('Weekly discovery error:', err.message);
    }
  }

  async scoutOnDemand(companyId, userQuery) {
    const company = await Company.findById(companyId);
    if (!company) throw new Error('Company not found');
    logger.info(`📱 On-demand: "${userQuery}" for ${company.name}`);
    const goal    = this._buildGoal(userQuery, company, true);
    const tenders = await this.agent.executeGoal(goal);
    const results = [];
    for (const td of tenders) {
      const saved = await this._saveTender(td);
      if (saved) { const m = await this._runMatching(saved, company); if (m) results.push({ tender: saved, match: m }); }
    }
    return results;
  }

  async _scoutForCompany(company, allowDiscovery) {
    const prefs     = company.tenderPreferences || {};
    const sectors   = (prefs.sectors?.length ? prefs.sectors : company.industry) || ['general services'];
    const locations = company.targetLocations?.length ? company.targetLocations : [{ country: 'International' }];
    const goals     = [];

    for (const loc of locations.slice(0, 3)) {
      for (const sector of sectors.slice(0, 3)) {
        goals.push({ query: sector, country: loc.country, region: loc.region, sector, company: company._id.toString(), minBudget: prefs.minBudget, maxBudget: prefs.maxBudget, allowDiscovery });
      }
    }
    const lastWin = (company.pastBids || []).find(b => b.won);
    if (lastWin) goals.push({ query: lastWin.sector || lastWin.tenderTitle, country: lastWin.country || locations[0]?.country, company: company._id.toString(), allowDiscovery });

    logger.info(`  🎯 ${company.name}: ${goals.length} goals`);
    for (const goal of goals) {
      try {
        const tenders = await this.agent.executeGoal(goal);
        for (const td of tenders) { const saved = await this._saveTender(td); if (saved) await this._runMatching(saved, company); }
        await this._sleep(3000 + Math.random() * 4000);
      } catch (e) { logger.warn(`  Goal failed (${company.name}): ${e.message}`); }
    }
  }

  async _saveTender(td) {
    try {
      const exists = await Tender.findOne({ 'source.url': td.source?.url });
      if (exists) return exists;
      const tender = await Tender.create({ ...td, agentDiscovered: true });
      logger.info(`  💾 "${tender.title?.substring(0, 60)}"`);
      if (this.io) this.io.emit('tender:new', { id: tender._id, title: tender.title, country: tender.location?.country });
      return tender;
    } catch (e) { if (e.code !== 11000) logger.warn(`Tender save: ${e.message}`); return null; }
  }

  async _runMatching(tender, company) {
    try {
      const result = await matchingEngine.matchTenderToCompany(tender, company);
      if (result.matchScore < 40) return null;
      const match = await TenderMatch.create({ tender: tender._id, company: company._id, matchScore: result.matchScore, confidenceScore: result.confidenceScore, reasoning: result.reasoning, analysis: result.analysis, competitorInsight: result.competitorInsight, winProbability: result.winProbability, shadowConflicts: result.shadowConflicts, requiresReview: result.requiresReview });
      try { const { getQueue } = require('../backend/services/queueService'); await getQueue('notify').add('send-alert', { matchId: match._id.toString() }, { priority: 8 }); } catch (_) {}
      if (this.io) this.io.to(`company:${company._id}`).emit('match:new', { tenderId: tender._id, title: tender.title, matchScore: result.matchScore, goNoGo: result.analysis?.goNoGo, winProbability: result.winProbability?.probability });
      return match;
    } catch (e) { logger.warn(`Matching: ${e.message}`); return null; }
  }

  async _handleHumanFallback({ url, goalId, screenshot, errors, message }) {
    logger.error(`🆘 Human fallback: ${message}`);
    const adminPhone = process.env.ADMIN_WHATSAPP_PHONE;
    if (!adminPhone) return;
    try {
      await sendWhatsAppMessage(adminPhone, `🤖⚠️ *Agent Needs Help!*\n\n*Goal:* ${goalId}\n*URL:* ${url}\n*Problem:* ${message}\n\n*Errors:*\n${errors.slice(-3).map(e => `• ${e.error}`).join('\n')}\n\nReply: *FIX ${goalId} [instruction]*`);
      if (url) await agentMemory.saveDomainKnowledge(new URL(url).hostname, { needsHumanHelp: true, failReason: message, lastFailedAt: new Date().toISOString() }).catch(() => {});
    } catch (e) { logger.error('Fallback alert failed:', e.message); }
  }

  async _handleTenderFound(td) {
    if (this.io) this.io.emit('tender:discovered', { title: td.title?.substring(0, 80), country: td.location?.country, ts: new Date().toISOString() });
  }

  _buildGoal(query, company, allowDiscovery = false) {
    const loc = company.targetLocations?.[0] || {};
    return { query: query.replace(/^(find|search|look for|get me)\s*/i, '').trim(), country: loc.country || 'Kenya', region: loc.region, sector: company.industry?.[0], company: company._id.toString(), minBudget: company.tenderPreferences?.minBudget, maxBudget: company.tenderPreferences?.maxBudget, allowDiscovery };
  }

  schedule() {
    const hours = parseInt(process.env.SCRAPE_INTERVAL_HOURS) || 6;
    cron.schedule(`0 */${hours} * * *`, () => this.runScoutingRound());
    cron.schedule('0 2 * * 0', () => this.runWeeklyDiscovery());
    setTimeout(() => this.runScoutingRound(), 15000);
    setTimeout(() => this.runWeeklyDiscovery(), 45000);
    logger.info(`📅 Scouting every ${hours}h | Discovery weekly (Sunday 02:00)`);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { AgentOrchestrator };
