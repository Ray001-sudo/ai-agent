/**
 * Win-Probability Engine
 *
 * Moves beyond "here is a tender" to "you have a 78% chance of winning."
 *
 *  1. Historical benchmarking — how this agency awards, at what price point
 *  2. Gap analysis          — certifications/experience the company lacks
 *  3. Pricing insight       — where to position the bid vs. market
 *  4. Final recommendation  — bid | skip | partner | review
 *
 * Uses shadowCall so each probability estimate is cross-validated by two models.
 */

const { logger } = require('../utils/logger');
const { shadowCall } = require('../core/llmClient');
const { WinProbabilitySchema, parseLLMOutput } = require('../core/schemas');

const SYSTEM = `You are a senior procurement strategist with 20 years of global tendering experience.
Given a company's profile and a tender, assess the probability of winning and provide actionable intelligence.
Be direct, data-driven, and brutally honest about weaknesses. Respond ONLY with valid JSON.`;

class WinProbabilityEngine {
  /**
   * @param {Object} tender   — Mongoose Tender document
   * @param {Object} company  — Mongoose Company document
   * @param {Array}  ragDocs  — similar past bids from vector store
   * @returns {Object}        WinProbabilitySchema-validated result
   */
  async analyse(tender, company, ragDocs = []) {
    const prompt = buildPrompt(tender, company, ragDocs);

    // Shadow call: Sonnet primary + Haiku shadow → flag if they disagree on probability
    const result = await shadowCall({
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      schema: WinProbabilitySchema,
      fallback: defaultResult(),
      watchFields: ['probability', 'recommendation']
    });

    if (result.requiresReview) {
      logger.warn(`  ⚠️  Win-probability shadow conflict on ${tender.title?.substring(0, 40)}`);
    }

    const { success, data } = parseLLMOutput(WinProbabilitySchema, JSON.stringify(result.data), defaultResult());
    return { ...data, shadowConflicts: result.conflicts, requiresReview: result.requiresReview };
  }
}

// ── Prompt builder ─────────────────────────────────────────────────────────────
function buildPrompt(tender, company, ragDocs) {
  const ragContext = ragDocs.slice(0, 4).map(d => `• ${d.content?.substring(0, 200)}`).join('\n');

  return `TENDER:
Title: ${tender.title}
Sector: ${tender.sector}
Country: ${tender.location?.country}
Budget: ${tender.financials?.currency} ${tender.financials?.estimatedValue?.toLocaleString() || 'undisclosed'}
Deadline: ${tender.dates?.closingDate ? new Date(tender.dates.closingDate).toDateString() : 'unknown'}
Requirements: ${(tender.requirements?.eligibility || []).join('; ')}
Certifications required: ${(tender.requirements?.certifications || []).join(', ') || 'none stated'}
Local content law: ${tender.requirements?.localContentRequirement || 'none stated'}
ESG requirements: ${tender.requirements?.esgRequirements || 'none stated'}

COMPANY:
Name: ${company.name}
Services: ${(company.services || []).join(', ')}
Certifications held: ${(company.certifications || []).map(c => c.name).join(', ') || 'none listed'}
Years operating: ${company.yearsFounded ? new Date().getFullYear() - company.yearsFounded : 'unknown'}
Past wins in this sector: ${(company.pastBids || []).filter(b => b.won && b.sector === tender.sector).length}

SIMILAR PAST WORK (from knowledge base):
${ragContext || 'No similar past work found in knowledge base'}

COMPETITOR CONTEXT:
${(company.competitorIntelligence || [])
  .filter(c => c.country === tender.location?.country && c.sector === tender.sector)
  .slice(0, 3)
  .map(c => `${c.competitorName}: ${c.tendersWon} wins, avg bid ${c.currency} ${c.avgWinAmount?.toLocaleString()}`)
  .join('\n') || 'No competitor data available'}

Analyse and respond ONLY with JSON:
{
  "probability": <0-100 integer>,
  "pricingInsight": "<where to position bid vs market, e.g. '10% below market avg of $2.4M'>",
  "gapAnalysis": [
    {"gap":"<what the company lacks>","severity":"blocker|warning|minor","remedy":"<how to fix>"}
  ],
  "historicalContext": "<how this specific agency usually awards, or null>",
  "recommendation": "bid|skip|partner|review"
}`;
}

function defaultResult() {
  return {
    probability: 50,
    pricingInsight: 'Insufficient data for precise pricing recommendation',
    gapAnalysis: [],
    historicalContext: null,
    recommendation: 'review'
  };
}

module.exports = { WinProbabilityEngine };
