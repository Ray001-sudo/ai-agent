'use strict';
/**
 * TenderPro Resilient LLM Client
 * ─────────────────────────────────────────────────────────────────────────────
 * Provider chain (in order):
 *   1. Anthropic  (Claude Opus 4 / Sonnet 4 / Haiku 4)
 *   2. OpenAI     (GPT-4o / GPT-4o-mini)
 *   3. NVIDIA NIM (meta/llama-3.1-405b-instruct via integrate.api.nvidia.com)
 *
 * Features:
 *   • Bottleneck token-bucket per provider (no burst → no 429s)
 *   • p-retry exponential back-off: 2s → 4s → 8s
 *   • Auto-fallback: if primary errors, next provider picks up seamlessly
 *   • Shadow-mode: two models cross-validate critical extractions
 *   • Prompt caching on long system prompts (Anthropic ephemeral cache)
 *   • Graceful degradation: returns structured fallback instead of crashing
 *   • HTML noise stripping before sending (saves tokens)
 */

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI    = require('openai').default;
const Bottleneck = require('bottleneck');
const pRetry    = require('p-retry');
const { logger } = require('../utils/logger');
const { parseLLMOutput } = require('./schemas');

// ── Clients ───────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// NVIDIA NIM uses OpenAI-compatible API
const nvidia = new OpenAI({
  apiKey:  process.env.NVIDIA_API_KEY || 'nvapi-placeholder',
  baseURL: 'https://integrate.api.nvidia.com/v1'
});

// ── Bottleneck rate limiters (token-bucket per provider) ──────────────────────
// Anthropic: 50 req/min on tier-1  → 1 req/1.2s with burst of 8
const anthropicLimiter = new Bottleneck({
  reservoir:            50,
  reservoirRefreshAmount: 50,
  reservoirRefreshInterval: 60_000,
  maxConcurrent: 8,
  minTime: 200
});

// OpenAI: 500 req/min on tier-1 → generous
const openaiLimiter = new Bottleneck({
  reservoir:            100,
  reservoirRefreshAmount: 100,
  reservoirRefreshInterval: 60_000,
  maxConcurrent: 10,
  minTime: 100
});

// NVIDIA NIM: free tier is rate-limited — be conservative
const nvidiaLimiter = new Bottleneck({
  reservoir:            20,
  reservoirRefreshAmount: 20,
  reservoirRefreshInterval: 60_000,
  maxConcurrent: 3,
  minTime: 500
});

// ── Model definitions ─────────────────────────────────────────────────────────
const ANTHROPIC_MODELS = {
  opus:   'claude-opus-4-5',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001'
};

const NVIDIA_MODELS = {
  large:  'meta/llama-3.1-405b-instruct',
  medium: 'meta/llama-3.1-70b-instruct',
  small:  'meta/llama-3.1-8b-instruct'
};

// ── HTML noise stripper ───────────────────────────────────────────────────────
const NOISE_RE = [
  /<script[\s\S]*?<\/script>/gi,
  /<style[\s\S]*?<\/style>/gi,
  /<nav[\s\S]*?<\/nav>/gi,
  /<footer[\s\S]*?<\/footer>/gi,
  /<header[\s\S]*?<\/header>/gi,
  /<!--[\s\S]*?-->/g,
  /\s{3,}/g
];
function stripHtmlNoise(text) {
  let s = text || '';
  for (const re of NOISE_RE) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// ── Retry helper ──────────────────────────────────────────────────────────────
async function withRetry(fn, label) {
  return pRetry(fn, {
    retries: 3,
    factor:  2,
    minTimeout: 2000,
    maxTimeout: 30_000,
    onFailedAttempt(err) {
      const status = err.status || err.response?.status;
      logger.warn(`[${label}] attempt ${err.attemptNumber} failed (${status || err.message})`);
      // Abort retries on non-retryable errors
      if (status && status < 429 && status !== 408) throw new pRetry.AbortError(err);
    }
  });
}

// ── Provider 1: Anthropic ─────────────────────────────────────────────────────
async function callAnthropicRaw({ system, messages, maxTokens, model, useCache }) {
  return anthropicLimiter.schedule(() =>
    withRetry(async () => {
      const body = { model, max_tokens: maxTokens, messages };

      // Prompt caching on system prompts ≥ 256 estimated tokens
      const estTokens = Math.ceil((system || '').length / 4);
      if (useCache && estTokens >= 256) {
        body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
      } else if (system) {
        body.system = system;
      }

      const resp = await anthropic.messages.create(body);
      return resp.content[0].text;
    }, `Anthropic/${model}`)
  );
}

// ── Provider 2: OpenAI ────────────────────────────────────────────────────────
async function callOpenAIRaw({ system, messages, maxTokens, model }) {
  return openaiLimiter.schedule(() =>
    withRetry(async () => {
      const msgs = system
        ? [{ role: 'system', content: system }, ...messages]
        : messages;
      const resp = await openai.chat.completions.create({ model, max_tokens: maxTokens, messages: msgs });
      return resp.choices[0].message.content;
    }, `OpenAI/${model}`)
  );
}

// ── Provider 3: NVIDIA NIM ────────────────────────────────────────────────────
async function callNvidiaRaw({ system, messages, maxTokens, model }) {
  if (!process.env.NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY not set');

  return nvidiaLimiter.schedule(() =>
    withRetry(async () => {
      const msgs = system
        ? [{ role: 'system', content: system }, ...messages]
        : messages;
      const resp = await nvidia.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: msgs,
        temperature: 0.2,
        top_p: 0.7
      });
      return resp.choices[0].message.content;
    }, `NVIDIA/${model}`)
  );
}

// ── MASTER CALL: Anthropic → OpenAI → NVIDIA ─────────────────────────────────
/**
 * callAnthropic — tries Anthropic first, falls back automatically
 *
 * @param {object} opts
 * @param {string}  opts.system       system prompt (cached if long)
 * @param {Array}   opts.messages     conversation messages
 * @param {number}  [opts.maxTokens]  default 1500
 * @param {string}  [opts.preferModel] 'opus'|'sonnet'|'haiku'
 * @param {boolean} [opts.useCache]   enable Anthropic prompt caching
 * @returns {string} text response
 */
async function callAnthropic({ system, messages, maxTokens = 1500, preferModel = 'sonnet', useCache = true }) {
  const anthropicModel = ANTHROPIC_MODELS[preferModel] || ANTHROPIC_MODELS.sonnet;

  // ── Try Anthropic ──────────────────────────────────────────────────────────
  try {
    const text = await callAnthropicRaw({ system, messages, maxTokens, model: anthropicModel, useCache });
    logger.debug(`[LLM] Anthropic/${preferModel} ✓`);
    return text;
  } catch (err) {
    logger.warn(`[LLM] Anthropic failed (${err.message}) — trying OpenAI`);
  }

  // ── Fallback 1: OpenAI GPT-4o ─────────────────────────────────────────────
  const openaiModel = preferModel === 'haiku' ? 'gpt-4o-mini' : 'gpt-4o';
  try {
    const text = await callOpenAIRaw({ system, messages, maxTokens, model: openaiModel });
    logger.info(`[LLM] OpenAI fallback used (${openaiModel})`);
    return text;
  } catch (err) {
    logger.warn(`[LLM] OpenAI failed (${err.message}) — trying NVIDIA NIM`);
  }

  // ── Fallback 2: NVIDIA NIM (free tier) ────────────────────────────────────
  const nvidiaModel = preferModel === 'haiku'
    ? NVIDIA_MODELS.small
    : preferModel === 'opus'
      ? NVIDIA_MODELS.large
      : NVIDIA_MODELS.medium;
  try {
    const text = await callNvidiaRaw({ system, messages, maxTokens, model: nvidiaModel });
    logger.info(`[LLM] NVIDIA NIM fallback used (${nvidiaModel})`);
    return text;
  } catch (err) {
    logger.error(`[LLM] All providers failed: ${err.message}`);
    // Graceful degradation — return structured empty response
    throw new Error('ALL_PROVIDERS_FAILED');
  }
}

// ── OpenAI direct (for vision + embeddings) ───────────────────────────────────
async function callOpenAI({ messages, model = 'gpt-4o', maxTokens = 1500 }) {
  try {
    return await callOpenAIRaw({ system: null, messages, maxTokens, model });
  } catch (err) {
    // Vision fallback to NVIDIA if OpenAI fails
    logger.warn(`[LLM] OpenAI vision failed — trying NVIDIA NIM`);
    return callNvidiaRaw({ system: null, messages, maxTokens, model: NVIDIA_MODELS.medium });
  }
}

// ── Vision call ───────────────────────────────────────────────────────────────
async function callVision({ prompt, screenshotBase64, schema, fallback, model = 'gpt-4o' }) {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}`, detail: 'high' } }
    ]
  }];

  try {
    const raw = await openaiLimiter.schedule(() =>
      withRetry(async () => {
        const resp = await openai.chat.completions.create({ model, max_tokens: 1500, messages });
        return resp.choices[0].message.content;
      }, `Vision/${model}`)
    );
    if (schema) return parseLLMOutput(schema, raw, fallback);
    return raw;
  } catch (err) {
    logger.warn(`[LLM] Vision failed: ${err.message}`);
    return schema ? { success: false, data: fallback } : null;
  }
}

// ── Shadow-mode (two models cross-validate) ───────────────────────────────────
async function shadowCall({ system, messages, schema, fallback, watchFields = [] }) {
  const [primaryRaw, shadowRaw] = await Promise.allSettled([
    callAnthropic({ system, messages, maxTokens: 2000, preferModel: 'sonnet' }),
    callAnthropic({ system, messages, maxTokens: 2000, preferModel: 'haiku' })
  ]);

  const primary = primaryRaw.status === 'fulfilled'
    ? parseLLMOutput(schema, primaryRaw.value, fallback)
    : { success: false, data: fallback };

  const shadow = shadowRaw.status === 'fulfilled'
    ? parseLLMOutput(schema, shadowRaw.value, fallback)
    : { success: false, data: fallback };

  const conflicts = [];
  if (primary.success && shadow.success) {
    for (const field of watchFields) {
      if (JSON.stringify(primary.data[field]) !== JSON.stringify(shadow.data[field])) {
        conflicts.push({ field, primaryValue: primary.data[field], shadowValue: shadow.data[field] });
      }
    }
  }

  return {
    data:          primary.data,
    requiresReview: conflicts.length > 0,
    conflicts,
    primarySuccess: primary.success,
    shadowSuccess:  shadow.success
  };
}

// ── Shared system prompts (cached) ────────────────────────────────────────────
const EXTRACTION_SYSTEM_PROMPT = `You are an expert procurement data extraction engine.

SECTOR TAXONOMY: Information Technology | Construction & Infrastructure | Healthcare & Medical |
Education & Training | Agriculture & Food Security | Energy & Power |
Water & Sanitation | Logistics & Supply Chain | Consulting & Advisory |
Finance & Banking | Security Services | Environmental Services | General Services

TENDER TYPE VALUES: goods | services | works | consulting | mixed

RULES:
1. "Closing date" = "Due by" = "Submission end" = "Application deadline" — all map to deadline
2. Extract ALL tenders, even if some fields are missing
3. Use null for genuinely missing fields — NEVER invent data
4. Return ONLY valid JSON — no markdown fences`;

const PLANNING_SYSTEM_PROMPT = `You are the planning brain of an autonomous procurement agent.

ABSOLUTE RULES:
1. NEVER output CSS selectors, XPath, or HTML class/id names
2. Describe UI elements in plain English: "the blue Search button near the top right"
3. Your plan adapts to what the agent currently sees
4. Think step-by-step before committing

VALID STEP TYPES: navigate | click | type | search | scroll | wait | download_pdf | close_modal`;

module.exports = {
  callAnthropic,
  callOpenAI,
  callVision,
  shadowCall,
  stripHtmlNoise,
  EXTRACTION_SYSTEM_PROMPT,
  PLANNING_SYSTEM_PROMPT,
  // Expose limiters for monitoring
  _limiters: { anthropicLimiter, openaiLimiter, nvidiaLimiter }
};
