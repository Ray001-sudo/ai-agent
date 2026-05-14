/**
 * TenderPro Core Agent Loop (v2)
 *
 * Wires together all v2 modules:
 *   PerceptionModule   — vision understanding, injection guard
 *   PlanningModule     — CoT planning with summarised memory
 *   ActionModule       — semantic browser driver
 *   ExtractionModule   — zero-shot with shadow-mode + hallucination guard
 *   DiscoveryModule    — neural search + verified portal registry
 *   AgentMemory        — four-tier memory
 *   WinProbabilityEngine — post-extraction scoring
 *
 * Key resilience features:
 *   ✓ Zod-validated LLM outputs everywhere (via individual modules)
 *   ✓ Model fallback chain (Opus → Sonnet → Haiku) in llmClient
 *   ✓ Self-correction loop with MAX_RETRIES pivot strategies
 *   ✓ Human-in-loop fallback when all strategies fail
 *   ✓ Verified-portal registry updated on each successful extraction
 *   ✓ Prompt injection detection in Perception
 *   ✓ Shadow-mode cross-validation in Extraction
 */

require('dotenv').config();
const { logger } = require('../utils/logger');
const { PerceptionModule } = require('../perception');
const { PlanningModule }   = require('../planning');
const { ActionModule }     = require('../action');
const { AgentMemory }      = require('../memory');
const { ExtractionModule } = require('../extraction');
const { DiscoveryModule }  = require('../discovery');

const MAX_RETRIES      = 5;
const GOAL_TIMEOUT_MS  = 300_000;  // 5 min
const MAX_STEPS        = 25;

class TenderAgentCore {
  constructor(options = {}) {
    this.perception  = new PerceptionModule();
    this.planning    = new PlanningModule();
    this.action      = new ActionModule();
    this.memory      = new AgentMemory();
    this.extraction  = new ExtractionModule();
    this.discovery   = new DiscoveryModule();

    this.onHumanNeeded  = options.onHumanNeeded  || defaultHumanFallback;
    this.onTenderFound  = options.onTenderFound   || null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  async executeGoal(goal) {
    const goalId = `goal_${Date.now()}`;
    logger.info(`🎯 [${goalId}] "${goal.query}" in ${goal.country || 'global'}`);

    const episode = {
      goalId, goal,
      startTime: Date.now(),
      steps: [], strategiesAttempted: [],
      tendersFound: [], errors: []
    };

    try {
      const candidates = await this._discover(goal, episode);
      for (const candidate of candidates.slice(0, 10)) {
        if (elapsed(episode) > GOAL_TIMEOUT_MS) break;
        await this._browse(candidate, goal, episode);
      }
    } catch (err) {
      logger.error(`[${goalId}] Goal error:`, err.message);
      episode.errors.push({ phase: 'goal', error: err.message });
    }

    await this.memory.saveEpisode(episode);
    logger.info(`[${goalId}] Done — ${episode.tendersFound.length} tenders`);
    return episode.tendersFound;
  }

  // ── Discovery phase ─────────────────────────────────────────────────────────
  async _discover(goal, episode) {
    // First: try the weekly verified-portal list (zero API cost)
    const weekly = await this.discovery.getWeeklyDirectCrawlList(goal.country);
    if (weekly.length > 0) {
      logger.info(`  📋 Using ${weekly.length} verified portals from registry`);
      episode.steps.push({ phase: 'discovery', result: `${weekly.length} verified portals` });
      return weekly;
    }

    // Otherwise: neural search
    const candidates = await this.discovery.findProcurementPortals(goal);
    episode.steps.push({ phase: 'discovery', result: `${candidates.length} from search` });
    return candidates;
  }

  // ── Browsing phase (agentic loop) ──────────────────────────────────────────
  async _browse(candidate, goal, episode) {
    const { url } = candidate;
    const domain = safeHostname(url);
    const domainMemory = await this.memory.getDomainKnowledge(domain);
    const patterns     = await this.memory.getBehavioralPatterns(domain);

    logger.info(`🌐 Browsing: ${url}`);

    let browser = null, page = null;
    let currentUrl = url;
    let retries = 0;

    try {
      browser = await this.action.launchBrowser();
      page    = await this.action.newPage(browser, { useProxy: true, humanLatency: true });

      while (retries < MAX_RETRIES) {
        episode.strategiesAttempted.push(`r${retries + 1}@${currentUrl}`);

        try {
          await this.action.navigate(page, currentUrl);

          // PERCEIVE
          const percept = await this.perception.perceive(page, currentUrl);
          logger.info(`  👁️ ${percept.summary} (confidence ${percept.confidence?.toFixed(2)})`);

          // Skip if injection detected
          if (percept.injectionDetected) {
            logger.warn(`  🛡️  Injection detected — skipping ${domain}`);
            break;
          }

          // Skip if login-walled (and we have memory confirming this)
          if (percept.hasLoginWall && domainMemory?.requiresLogin) {
            logger.info(`  🔑 Login wall — skipping (known from memory)`);
            break;
          }

          // PLAN
          const plan = await this.planning.createPlan({
            goal, percept, domainMemory: { ...domainMemory, behavioralPatterns: patterns },
            currentUrl, previousSteps: episode.steps
          });

          episode.steps.push({ phase: 'plan', reasoning: plan.reasoning, url: currentUrl });

          // ACT through plan steps
          let stepIdx = 0, planDone = false;

          while (stepIdx < MAX_STEPS && !planDone) {
            const step = plan.steps[stepIdx];
            if (!step) break;

            // Inject goal query into search steps if missing
            if (step.type === 'search' && !step.query) step.query = goal.query;

            await this._executeStep(page, step, episode);
            const newPercept = await this.perception.perceive(page, page.url());
            currentUrl = page.url();

            if (newPercept.hasTenderList) {
              // EXTRACT
              const raw = await page.evaluate(() => document.body?.innerText || '');
              const screenshot = newPercept.screenshot;
              const tenders = await this.extraction.extractTenders(raw, screenshot, {
                sourceName: candidate.sourceName,
                sourceUrl: currentUrl,
                country: goal.country,
                sector: goal.sector
              });

              episode.tendersFound.push(...tenders);
              planDone = true;

              // Notify caller in real-time
              for (const t of tenders) {
                if (this.onTenderFound) await this.onTenderFound(t).catch(() => {});
              }

              // Save verified portal if we found tenders
              if (tenders.length > 0) {
                await this.discovery.markPortalVerified(url, {
                  country: goal.country,
                  sector: goal.sector,
                  tendersFound: tenders.length
                });
              }

              // Paginate
              if (newPercept.hasPagination) {
                await this._paginate(page, newPercept, goal, episode, candidate.sourceName);
              }

            } else if (newPercept.is404 || newPercept.isError) {
              const fix = await this.planning.createCorrectionPlan({
                goal, currentUrl, error: newPercept.errorType || '404',
                previousSteps: episode.steps
              });
              plan.steps = fix.steps;
              stepIdx = 0;
              continue;

            } else if (newPercept.isBlocked) {
              throw new Error('BLOCKED: anti-bot detection triggered');
            }

            stepIdx++;
          }

          if (planDone) break;

          // No tenders found — try alternative query
          const alt = await this.planning.suggestAlternativeQuery(goal);
          if (alt && retries < MAX_RETRIES - 1) {
            logger.info(`  🔄 Alt query: "${alt}"`);
            goal = { ...goal, query: alt };
          }

        } catch (err) {
          logger.warn(`  Retry ${retries + 1}/${MAX_RETRIES}: ${err.message}`);
          episode.errors.push({ url: currentUrl, error: err.message, retry: retries });
          if (err.message.includes('BLOCKED')) await this.action.rotateBrowser();
        }

        retries++;
        if (retries < MAX_RETRIES) await sleep(2000 * retries);
      }

      // Human fallback if everything failed
      if (retries >= MAX_RETRIES && episode.tendersFound.length === 0) {
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
        await this.onHumanNeeded({ url: currentUrl, goalId: episode.goalId, screenshot, errors: episode.errors, message: `Failed after ${MAX_RETRIES} strategies` });
      }

      // Save domain knowledge
      await this.memory.saveDomainKnowledge(domain, {
        successRate:       episode.tendersFound.length > 0 ? 1 : 0,
        tendersFound:      episode.tendersFound.length,
        requiresLogin:     episode.errors.some(e => /login/i.test(e.error || '')),
        lastVisited:       new Date()
      });

    } finally {
      await page?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  // ── Execute a single plan step ─────────────────────────────────────────────
  async _executeStep(page, step, episode) {
    logger.info(`  🤚 ${step.type} — ${step.description}`);
    switch (step.type) {
      case 'navigate':    await this.action.navigate(page, step.url); break;
      case 'click':       await this.action.semanticClick(page, step.target, step.description); break;
      case 'type':        await this.action.typeInField(page, step.target, step.value); break;
      case 'search':      await this.action.performSearch(page, step.query); break;
      case 'scroll':      await this.action.scrollDown(page); break;
      case 'wait':        await sleep(step.ms || 1500); break;
      case 'close_modal': await this.action.closeModal(page); break;
      case 'download_pdf':
        if (step.url) {
          const { buffer } = await this.action.downloadAndAnalyzePDF(page, step.url);
          episode._lastPdfBuffer = buffer;
        }
        break;
    }
    episode.steps.push({ action: step.type, ts: Date.now() });
  }

  // ── Pagination handler ────────────────────────────────────────────────────
  async _paginate(page, percept, goal, episode, sourceName) {
    let pageNum = 1;
    while (pageNum < 8 && percept.nextPageSelector) {
      try {
        await this.action.semanticClick(page, percept.nextPageSelector, 'next page button');
        await sleep(2000);
        const np = await this.perception.perceive(page, page.url());
        if (!np.hasTenderList) break;

        const raw = await page.evaluate(() => document.body?.innerText || '');
        const tenders = await this.extraction.extractTenders(raw, np.screenshot, {
          sourceName, sourceUrl: page.url(), country: goal.country, sector: goal.sector
        });

        if (tenders.length === 0) break;
        episode.tendersFound.push(...tenders);
        pageNum++;
        percept = np;
      } catch { break; }
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function elapsed(ep) { return Date.now() - ep.startTime; }
function safeHostname(url) { try { return new URL(url).hostname; } catch { return url; } }
function defaultHumanFallback({ url, message }) { logger.error(`🆘 Human needed at ${url}: ${message}`); }

module.exports = { TenderAgentCore };
