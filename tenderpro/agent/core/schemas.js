/**
 * LLM Output Schemas — Hallucination Guard
 *
 * Every response from an LLM is validated through Zod before the agent
 * acts on it. If the model returns {"type":"tap"} instead of {"type":"click"},
 * Zod catches it before the browser crashes.
 *
 * Also implements the Cross-Reference Hallucination Check:
 * extracted fields are verified against the raw page text before saving.
 */

const { z } = require('zod');

// ── Valid action types the agent's hands can execute ──────────────────────────
const ActionType = z.enum([
  'navigate', 'click', 'type', 'search',
  'scroll', 'wait', 'download_pdf', 'close_modal'
]);

// ── A single plan step ────────────────────────────────────────────────────────
const PlanStepSchema = z.object({
  type: ActionType,
  description: z.string().min(3).max(300),
  target: z.string().max(400).optional().nullable(),
  value: z.string().max(1000).optional().nullable(),
  url: z.string().url().optional().nullable(),
  query: z.string().max(200).optional().nullable(),
  ms: z.number().int().min(100).max(10000).optional().nullable()
}).strip(); // strip unknown keys instead of throwing

// ── Full planning response ─────────────────────────────────────────────────────
const PlanSchema = z.object({
  reasoning: z.string().min(10).max(2000),
  confidence: z.number().min(0).max(1),
  steps: z.array(PlanStepSchema).min(1).max(15),
  expectedOutcome: z.string().max(500).optional().nullable(),
  fallbackStrategy: z.string().max(500).optional().nullable()
}).strip();

// ── Correction / re-plan response ─────────────────────────────────────────────
const CorrectionPlanSchema = z.object({
  diagnosis: z.string().min(5).max(1000),
  recoveryStrategy: z.string().min(5).max(1000),
  steps: z.array(PlanStepSchema).min(1).max(10)
}).strip();

// ── Vision perception response ────────────────────────────────────────────────
const PerceptionSchema = z.object({
  summary: z.string().max(500),
  hasTenderList: z.boolean(),
  tenderListDescription: z.string().max(500).optional().nullable(),
  hasPagination: z.boolean(),
  nextPageSelector: z.string().max(300).optional().nullable(),
  hasSearchBar: z.boolean(),
  searchBarDescription: z.string().max(300).optional().nullable(),
  hasLoginWall: z.boolean(),
  hasNavigationMenu: z.boolean(),
  navigationLinks: z.array(z.string().max(100)).optional().default([]),
  is404: z.boolean(),
  isError: z.boolean(),
  errorType: z.string().max(100).optional().nullable(),
  isBlocked: z.boolean(),
  isCaptcha: z.boolean(),
  interactiveElements: z.array(z.object({
    type: z.enum(['button', 'input', 'link', 'dropdown', 'other']),
    description: z.string().max(200),
    approximatePosition: z.enum(['top-left', 'top-center', 'top-right', 'center', 'bottom', 'unknown']).optional(),
    text: z.string().max(100).optional().nullable(),
    likellyRelevant: z.boolean().optional()
  })).optional().default([]),
  confidence: z.number().min(0).max(1)
}).strip();

// ── Vision element location ───────────────────────────────────────────────────
const ElementLocationSchema = z.object({
  found: z.boolean(),
  x: z.number().min(0).max(3840).optional(),
  y: z.number().min(0).max(2160).optional(),
  confidence: z.number().min(0).max(1).optional()
}).strip();

// ── A single extracted tender ─────────────────────────────────────────────────
const RawTenderSchema = z.object({
  title: z.string().min(3).max(500),
  reference: z.string().max(100).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  deadline: z.string().max(100).optional().nullable(),
  estimatedValue: z.union([z.number(), z.string(), z.null()]).optional(),
  currency: z.string().max(10).optional().nullable(),
  tenderType: z.enum(['goods', 'services', 'works', 'consulting', 'mixed']).optional().nullable(),
  requirements: z.array(z.string().max(500)).optional().default([]),
  documentUrl: z.string().max(2000).optional().nullable(),
  language: z.string().max(10).optional().nullable()
}).strip();

const ExtractionResultSchema = z.array(RawTenderSchema);

// ── Go/No-Go analysis ─────────────────────────────────────────────────────────
const GoNoGoSchema = z.object({
  matchScore: z.number().int().min(0).max(100),
  goNoGo: z.enum(['go', 'no_go', 'review']),
  reasoning: z.string().min(10).max(1000),
  strengths: z.array(z.string().max(300)).max(5).default([]),
  risks: z.array(z.string().max(300)).max(5).default([]),
  dealBreakers: z.array(z.string().max(300)).max(3).default([]),
  recommendations: z.array(z.string().max(300)).max(3).default([]),
  pastSimilarBid: z.object({
    title: z.string().max(300).nullable(),
    won: z.boolean().nullable(),
    year: z.number().int().min(1990).max(2030).nullable(),
    value: z.number().nullable()
  }).nullable().default(null),
  timelineRisk: z.enum(['low', 'medium', 'high']).optional(),
  budgetAlignment: z.enum(['under_budget', 'within_budget', 'over_budget', 'unknown']).optional()
}).strip();

// ── Voice command parse result ────────────────────────────────────────────────
const VoiceCommandSchema = z.object({
  intent: z.enum(['search', 'check_status', 'get_draft', 'find_competitors', 'other']),
  sector: z.string().max(100).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  region: z.string().max(100).nullable().optional(),
  timeframe: z.string().max(20).nullable().optional(),
  tenderType: z.enum(['goods', 'services', 'works', 'consulting']).nullable().optional(),
  minBudget: z.number().nullable().optional(),
  maxBudget: z.number().nullable().optional(),
  keywords: z.array(z.string().max(50)).max(10).default([])
}).strip();

// ── Win-probability engine output ─────────────────────────────────────────────
const WinProbabilitySchema = z.object({
  probability: z.number().min(0).max(100),
  pricingInsight: z.string().max(500),
  gapAnalysis: z.array(z.object({
    gap: z.string().max(200),
    severity: z.enum(['blocker', 'warning', 'minor']),
    remedy: z.string().max(300).optional()
  })).default([]),
  historicalContext: z.string().max(500).optional().nullable(),
  recommendation: z.enum(['bid', 'skip', 'partner', 'review'])
}).strip();

// ── Shadow-mode verification (two-model cross-check) ─────────────────────────
const ShadowVerificationSchema = z.object({
  agree: z.boolean(),
  primaryResult: z.record(z.unknown()),
  shadowResult: z.record(z.unknown()),
  conflicts: z.array(z.object({
    field: z.string(),
    primaryValue: z.unknown(),
    shadowValue: z.unknown()
  })).default([]),
  requiresHumanReview: z.boolean()
});

// ── Safe parse helper: validate + coerce, never throw ────────────────────────
/**
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {unknown} data        raw LLM output (already JSON.parse'd)
 * @param {T} fallback          returned when validation fails
 * @returns {{ success: boolean, data: T, errors?: string[] }}
 */
function safeParse(schema, data, fallback) {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
  return { success: false, data: fallback, errors };
}

/**
 * Parse raw LLM text → validated object.
 * Strips ```json fences, attempts JSON.parse, then validates.
 *
 * @template T
 * @param {z.ZodType<T>} schema
 * @param {string} rawText      raw string from LLM
 * @param {T} fallback
 * @returns {{ success: boolean, data: T, errors?: string[] }}
 */
function parseLLMOutput(schema, rawText, fallback) {
  try {
    const cleaned = (rawText || '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .replace(/\/\/[^\n]*/g, '')   // strip JS-style line comments
      .replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments
      .trim();

    const parsed = JSON.parse(cleaned);
    return safeParse(schema, parsed, fallback);
  } catch (e) {
    return { success: false, data: fallback, errors: [`JSON parse failed: ${e.message}`] };
  }
}

// ── Cross-reference hallucination guard ──────────────────────────────────────
/**
 * Verify extracted field value exists in source text.
 * Returns true if found (or if value is null/empty — absence is fine).
 *
 * @param {string|null|undefined} extractedValue  e.g. "June 14th, 2026"
 * @param {string} sourceText                     raw page text
 * @param {number} [minMatchLen=4]               minimum substring length to search
 */
function crossReferenceVerify(extractedValue, sourceText, minMatchLen = 4) {
  if (!extractedValue || extractedValue.length < minMatchLen) return true;
  const haystack = (sourceText || '').toLowerCase();

  // Try progressive substring matches (handle date formatting differences)
  const needle = extractedValue.toLowerCase();
  if (haystack.includes(needle)) return true;

  // Try numeric substrings (e.g. "2026" from "June 14th, 2026")
  const numbers = needle.match(/\d{4}|\d{1,2}[\/\-]\d{1,2}/g) || [];
  return numbers.some(n => haystack.includes(n));
}

/**
 * Run cross-reference check on all critical fields of an extracted tender.
 * Returns array of field names that failed verification.
 */
function auditTenderExtraction(tender, sourceText) {
  const failedFields = [];
  const criticalFields = ['deadline', 'reference'];

  for (const field of criticalFields) {
    const val = tender[field];
    if (val && !crossReferenceVerify(String(val), sourceText)) {
      failedFields.push(field);
    }
  }
  return failedFields;
}

module.exports = {
  // Schemas
  PlanSchema,
  PlanStepSchema,
  CorrectionPlanSchema,
  PerceptionSchema,
  ElementLocationSchema,
  ExtractionResultSchema,
  RawTenderSchema,
  GoNoGoSchema,
  VoiceCommandSchema,
  WinProbabilitySchema,
  ShadowVerificationSchema,
  // Helpers
  safeParse,
  parseLLMOutput,
  crossReferenceVerify,
  auditTenderExtraction
};
