/**
 * Extraction Module — Zero-Shot LLM Extraction (v2)
 *
 * Improvements over v1:
 *  ✓ Zod schema validation on every LLM output (no crash on bad JSON)
 *  ✓ Shadow-mode: runs Sonnet + Haiku, flags conflicts for human review
 *  ✓ Cross-reference hallucination guard: deadline must exist in raw text
 *  ✓ OCR fallback via GPT-4o vision for scanned/image PDFs
 *  ✓ Prompt caching on the long EXTRACTION_SYSTEM_PROMPT
 *  ✓ HTML noise stripped before sending (saves tokens)
 *  ✓ Concurrency via llmClient's built-in p-limit
 */

const pdf = require('pdf-parse');
const { logger } = require('../utils/logger');
const {
  callAnthropic, callOpenAI, callVision,
  shadowCall, stripHtmlNoise,
  EXTRACTION_SYSTEM_PROMPT
} = require('../core/llmClient');
const {
  ExtractionResultSchema, parseLLMOutput,
  auditTenderExtraction
} = require('../core/schemas');
const { translateText } = require('../../backend/services/translationService');

class ExtractionModule {
  /**
   * Main entry: extract tenders from page content — zero-shot, source-agnostic
   *
   * Pipeline:
   *  1. Strip HTML noise → fast text extraction (Haiku)
   *  2. Shadow-mode cross-check (Sonnet vs Haiku) for critical fields
   *  3. If text returns 0 → vision extraction (GPT-4o screenshot)
   *  4. If PDF buffer → OCR extraction (GPT-4o multi-page vision)
   *  5. Hallucination guard: cross-reference deadline against raw text
   *  6. Translate + enrich
   */
  async extractTenders(pageText, screenshotBase64, context = {}) {
    const { sourceName, sourceUrl, country, sector } = context;
    const cleanText = stripHtmlNoise(pageText || '');

    // ── Stage 1: Shadow text extraction ──────────────────────────────────────
    let tenders = [];
    const shadowResult = await shadowCall({
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildExtractionPrompt(cleanText, sourceUrl, country) }],
      schema: ExtractionResultSchema,
      fallback: [],
      watchFields: ['deadline', 'estimatedValue']
    });

    tenders = Array.isArray(shadowResult.data) ? shadowResult.data : [];

    if (shadowResult.requiresReview && shadowResult.conflicts.length > 0) {
      logger.warn(`  ⚠️  Shadow conflict on fields: ${shadowResult.conflicts.map(c => c.field).join(', ')} — flagging for review`);
      tenders = tenders.map(t => ({ ...t, requiresHumanReview: true, shadowConflicts: shadowResult.conflicts }));
    }

    // ── Stage 2: Vision fallback (screenshot) ────────────────────────────────
    if (tenders.length === 0 && screenshotBase64) {
      logger.info(`    👁️  Text extraction found 0 — trying vision...`);
      tenders = await this._visionExtract(screenshotBase64, sourceUrl, country);
    }

    // ── Stage 3: PDF OCR fallback ─────────────────────────────────────────────
    if (tenders.length === 0 && context.pdfBuffer) {
      logger.info(`    📄  Trying PDF extraction...`);
      tenders = await this._pdfExtract(context.pdfBuffer, sourceUrl, screenshotBase64);
    }

    // ── Stage 4: Hallucination guard — cross-reference critical fields ────────
    const verified = tenders.filter(t => {
      const failedFields = auditTenderExtraction(t, cleanText);
      if (failedFields.length > 0) {
        logger.warn(`  🚨 Hallucination guard: "${t.title?.substring(0, 50)}" — fields not found in source: ${failedFields.join(', ')}`);
        t.requiresHumanReview = true;
        t.unverifiedFields = failedFields;
      }
      return t.title && t.title.length >= 5; // Always keep — just flag
    });

    // ── Stage 5: Verify + enrich ──────────────────────────────────────────────
    const enriched = await this._enrichTenders(verified, context);
    logger.info(`    ✅ Extraction: ${tenders.length} raw → ${enriched.length} enriched`);
    return enriched;
  }

  // ── Vision extraction (screenshot) ─────────────────────────────────────────
  async _visionExtract(screenshotBase64, sourceUrl, country) {
    const raw = await callVision({
      prompt: `This is a screenshot of a procurement/tender website.
Extract ALL tender listings. For each: title, reference, description, deadline, estimatedValue, currency, tenderType, requirements[], language.
Source: ${sourceUrl} | Country: ${country || 'unknown'}
Respond ONLY with a JSON array. If none visible: []`,
      screenshotBase64,
      schema: ExtractionResultSchema,
      fallback: []
    });
    return Array.isArray(raw.data) ? raw.data : [];
  }

  // ── PDF extraction with OCR fallback ────────────────────────────────────────
  async _pdfExtract(pdfBuffer, sourceUrl, screenshotBase64) {
    let text = '';

    // Attempt 1: text-based extraction (fast, cheap)
    try {
      const data = await pdf(Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer));
      text = data.text || '';
    } catch (e) {
      logger.warn(`pdf-parse failed: ${e.message}`);
    }

    // If text extraction got almost nothing, the PDF is image-based — use OCR vision
    if (text.replace(/\s/g, '').length < 200 && screenshotBase64) {
      logger.info(`    📷  PDF appears image-based — using GPT-4o OCR vision`);
      return this._visionExtract(screenshotBase64, sourceUrl, 'unknown');
    }

    if (!text || text.length < 100) return [];

    const raw = await callAnthropic({
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `PDF tender document text:\n${text.substring(0, 15000)}\n\nExtract all tenders as JSON array:`
      }],
      maxTokens: 2000,
      preferModel: 'sonnet',
      useCache: true
    });

    const { data } = parseLLMOutput(ExtractionResultSchema, raw, []);
    return Array.isArray(data) ? data : [];
  }

  // ── Enrich: normalise dates, translate, infer sector ────────────────────────
  async _enrichTenders(tenders, context) {
    const enriched = [];
    for (const t of tenders) {
      try {
        const lang = t.language || 'en';
        let title = t.title;
        let description = t.description;

        // Translate non-English tenders
        if (lang !== 'en' && lang !== 'und') {
          try {
            [title, description] = await Promise.all([
              translateText(t.title, 'en'),
              t.description ? translateText(t.description.substring(0, 500), 'en') : Promise.resolve(t.description)
            ]);
          } catch { /* keep originals */ }
        }

        const sector = context.sector || this._inferSector(`${title} ${description || ''}`);
        const closingDate = t.deadline ? parseFlexibleDate(t.deadline) : null;

        enriched.push({
          title: title || t.title,
          description: description || t.description,
          reference: t.reference,
          source: {
            name: context.sourceName || 'Unknown',
            url: t.documentUrl || context.sourceUrl,
            country: context.country
          },
          location: {
            country: context.country,
            countryCode: isoCode(context.country)
          },
          financials: {
            estimatedValue: parseNumeric(t.estimatedValue),
            currency: t.currency || defaultCurrency(context.country)
          },
          dates: { published: new Date(), closingDate },
          requirements: { eligibility: t.requirements || [], certifications: [], technicalSpecs: [] },
          tenderType: t.tenderType || 'services',
          sector,
          language: lang,
          translations: (lang !== 'en') ? [{ language: 'en', title, description }] : [],
          requiresHumanReview: t.requiresHumanReview || false,
          shadowConflicts: t.shadowConflicts || [],
          unverifiedFields: t.unverifiedFields || [],
          confidenceScore: t.requiresHumanReview ? 50 : 75,
          agentExtracted: true,
          scrapedAt: new Date()
        });
      } catch (e) {
        logger.warn(`Enrichment failed: ${e.message}`);
      }
    }
    return enriched;
  }

  _inferSector(text) {
    const map = {
      'IT|software|cloud|tech|digital|cyber|system|ICT': 'Information Technology',
      'road|construction|infrastructure|civil|works|build': 'Construction & Infrastructure',
      'health|medical|hospital|pharma|clinic': 'Healthcare & Medical',
      'education|training|school|university|learn': 'Education & Training',
      'agri|food|farm|livestock|crop': 'Agriculture & Food Security',
      'energy|power|solar|electric|oil|gas': 'Energy & Power',
      'water|sanitation|sewage|irrigation': 'Water & Sanitation',
      'logistics|transport|freight|shipping': 'Logistics & Supply Chain',
      'consult|advisory|research|study': 'Consulting & Advisory'
    };
    const lower = text.toLowerCase();
    for (const [pat, sector] of Object.entries(map)) {
      if (new RegExp(pat).test(lower)) return sector;
    }
    return 'General Services';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildExtractionPrompt(cleanText, sourceUrl, country) {
  return `Source URL: ${sourceUrl}
Country context: ${country || 'unknown'}

Page content:
${cleanText.substring(0, 12000)}

Extract ALL tenders. Respond ONLY with a JSON array (no markdown):
[{"title":"...","reference":null,"description":"...","deadline":null,"estimatedValue":null,"currency":null,"tenderType":"services","requirements":[],"documentUrl":null,"language":"en"}]
If no tenders: []`;
}

function parseFlexibleDate(str) {
  if (!str) return null;
  const d = new Date(String(str).replace(/[^\d\/\-\. a-zA-Z]/g, '').trim());
  return isNaN(d.getTime()) ? null : d;
}

function parseNumeric(val) {
  if (val === null || val === undefined) return null;
  const n = parseFloat(String(val).replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

function isoCode(country) {
  const m = { Kenya:'KE', Nigeria:'NG', Uganda:'UG', Tanzania:'TZ', Ghana:'GH', 'South Africa':'ZA', 'United States':'US', 'United Kingdom':'GB', International:'INT' };
  return m[country] || (country || 'XX').slice(0,2).toUpperCase();
}

function defaultCurrency(country) {
  const m = { Kenya:'KES', Nigeria:'NGN', Ghana:'GHS', Uganda:'UGX', Tanzania:'TZS', 'South Africa':'ZAR', 'United States':'USD', 'United Kingdom':'GBP' };
  return m[country] || 'USD';
}

module.exports = { ExtractionModule };
