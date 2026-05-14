/**
 * Planning Module — Chain-of-Thought Goal Decomposition (v2)
 *
 * Improvements over v1:
 *  ✓ All LLM outputs validated through Zod schemas (no raw JSON.parse crash)
 *  ✓ Uses cached system prompt (saves ~90% input tokens on repeat calls)
 *  ✓ Summarised memory: previousSteps is compressed to a short paragraph,
 *    not a raw JSON array — prevents context-window overflow
 *  ✓ Model fallback chain via llmClient (Opus → Sonnet → Haiku)
 */

const { logger } = require('../utils/logger');
const { callAnthropic, PLANNING_SYSTEM_PROMPT } = require('../core/llmClient');
const { PlanSchema, CorrectionPlanSchema, parseLLMOutput } = require('../core/schemas');

const DEFAULT_PLAN = (percept) => ({
  reasoning: 'Fallback: heuristic plan after LLM failure',
  confidence: 0.3,
  steps: percept?.hasSearchBar
    ? [
        { type: 'search', query: null, description: 'Use the search bar to find tenders', target: 'search input field' },
        { type: 'wait', ms: 2000, description: 'Wait for results' }
      ]
    : percept?.hasNavigationMenu
    ? [
        { type: 'click', target: 'navigation link about tenders or procurement', description: 'Click procurement link' },
        { type: 'wait', ms: 2000, description: 'Wait for page load' }
      ]
    : [{ type: 'scroll', description: 'Scroll to discover more content' }],
  expectedOutcome: 'Tender list or search results',
  fallbackStrategy: 'Navigate to homepage and retry'
});

function summariseSteps(steps) {
  if (!steps || steps.length === 0) return 'No previous steps.';
  if (steps.length <= 3) return steps.map(s => s.plan || s.action || '(action)').join(' → ');
  const first = steps.slice(0, 2).map(s => s.plan || s.action || '(action)');
  const last  = steps.slice(-2).map(s => s.plan || s.action || '(action)');
  return `${first.join(' → ')} … [${steps.length - 4} more] … ${last.join(' → ')}`;
}

class PlanningModule {
  async createPlan({ goal, percept, domainMemory, currentUrl, previousSteps = [] }) {
    const userPrompt = `CURRENT PAGE STATE:
URL: ${currentUrl}
Summary: ${percept.summary}
Has tender list: ${percept.hasTenderList}${percept.tenderListDescription ? ` — ${percept.tenderListDescription}` : ''}
Has search bar: ${percept.hasSearchBar}${percept.searchBarDescription ? ` — ${percept.searchBarDescription}` : ''}
Nav links: ${(percept.navigationLinks || []).slice(0, 8).join(', ') || 'none'}
Login wall: ${percept.hasLoginWall} | Blocked: ${percept.isBlocked} | 404: ${percept.is404}
${percept.isCaptcha ? '⚠️  CAPTCHA DETECTED' : ''}

MISSION: Query="${goal.query}", Country=${goal.country || 'any'}, Sector=${goal.sector || 'any'}

DOMAIN MEMORY: ${domainMemory ? JSON.stringify(domainMemory).substring(0, 400) : 'No prior knowledge'}

STEP HISTORY: ${summariseSteps(previousSteps)}

Think step-by-step. Respond ONLY with JSON:
{"reasoning":"...","confidence":0.8,"steps":[{"type":"click","description":"...","target":"...","value":null,"url":null,"query":null,"ms":null}],"expectedOutcome":"...","fallbackStrategy":"..."}`;

    const raw = await callAnthropic({
      system: PLANNING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 1500, preferModel: 'sonnet', useCache: true
    });

    const { success, data, errors } = parseLLMOutput(PlanSchema, raw, DEFAULT_PLAN(percept));
    if (!success) logger.warn(`Planning validation failed (${errors?.join('; ')}) — using fallback`);
    else logger.info(`  🧠 Plan: ${data.steps.length} steps, confidence ${data.confidence.toFixed(2)}`);
    return data;
  }

  async createCorrectionPlan({ goal, currentUrl, error, previousSteps = [] }) {
    const userPrompt = `AGENT HIT A PROBLEM — NEEDS TO RE-PLAN.
Problem: ${error}
URL: ${currentUrl}
Goal: "${goal.query}" in ${goal.country || 'global'}
History: ${summariseSteps(previousSteps)}

Respond ONLY with JSON:
{"diagnosis":"...","recoveryStrategy":"...","steps":[{"type":"navigate","description":"Go to homepage","url":"${safeOrigin(currentUrl)}"}]}`;

    const fallback = {
      diagnosis: 'Unknown error',
      recoveryStrategy: 'Navigate to homepage and search',
      steps: [
        { type: 'navigate', url: safeOrigin(currentUrl), description: 'Go to site homepage' },
        { type: 'search', query: goal.query, description: 'Use site search' }
      ]
    };

    const raw = await callAnthropic({
      system: PLANNING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 800, preferModel: 'haiku', useCache: true
    });

    const { success, data, errors } = parseLLMOutput(CorrectionPlanSchema, raw, fallback);
    if (!success) logger.warn(`Correction plan validation failed: ${errors?.join('; ')}`);
    logger.info(`  🔄 Correction: ${data.diagnosis}`);
    return data;
  }

  async suggestAlternativeQuery(goal) {
    const synonyms = {
      software: ['ICT', 'information technology', 'digital systems'],
      construction: ['works', 'infrastructure', 'civil works'],
      consulting: ['advisory', 'professional services', 'technical assistance'],
      healthcare: ['medical', 'health services', 'pharmaceutical'],
      IT: ['information technology', 'ICT', 'software'],
      cloud: ['SaaS', 'hosting', 'IT infrastructure']
    };
    const words = (goal.query || '').toLowerCase().split(' ');
    for (const w of words) {
      const list = synonyms[w];
      if (list) return list[Math.floor(Math.random() * list.length)];
    }
    try {
      const raw = await callAnthropic({
        system: 'Reply with ONE alternative procurement search term only — no explanation.',
        messages: [{ role: 'user', content: `"${goal.query}" returned no results. One alternative term:` }],
        maxTokens: 20, preferModel: 'haiku', useCache: true
      });
      return raw.trim().replace(/['"]/g, '');
    } catch { return null; }
  }
}

function safeOrigin(url) { try { return new URL(url).origin; } catch { return url; } }

module.exports = { PlanningModule };
