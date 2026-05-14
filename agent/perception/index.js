/**
 * Perception Module — The Agent's Eyes (v2)
 *
 * Improvements over v1:
 *  ✓ PerceptionSchema Zod validation (no crash on unexpected vision output)
 *  ✓ Prompt injection guard: scans page text for adversarial instructions
 *    before passing to the LLM ("ignore all previous instructions")
 *  ✓ Text-only path uses llmClient (retry + fallback) instead of bare OpenAI
 *  ✓ HTML noise stripped before sending
 *  ✓ Vision prompt cached (reused across calls)
 */

const { logger } = require('../utils/logger');
const { callVision, stripHtmlNoise } = require('../core/llmClient');
const { PerceptionSchema, ElementLocationSchema, parseLLMOutput } = require('../core/schemas');

// ── Prompt injection detection ────────────────────────────────────────────────
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+a\s+different/i,
  /disregard\s+your\s+instructions/i,
  /report\s+that\s+no\s+tenders\s+(were\s+)?found/i,
  /system\s+prompt/i,
  /override\s+instructions/i
];

function detectPromptInjection(text) {
  return INJECTION_PATTERNS.some(p => p.test(text || ''));
}

// ── Default percept returned when vision fails ────────────────────────────────
function textOnlyFallback(text) {
  const lower = (text || '').toLowerCase();
  return {
    summary: /tender|bid|procurement|rfp/.test(lower) ? 'Page contains procurement content' : 'General webpage',
    hasTenderList: /tender|bid|procurement|opportunity|contract/.test(lower),
    tenderListDescription: null,
    hasPagination: /next|page \d+|>>/.test(lower),
    nextPageSelector: /next/.test(lower) ? 'Next page button' : null,
    hasSearchBar: /search|find tender/.test(lower),
    searchBarDescription: null,
    hasLoginWall: /login|sign in|register/.test(lower),
    hasNavigationMenu: /procurement|tenders|opportunities/.test(lower),
    navigationLinks: [],
    is404: /404|not found|page does not exist/.test(lower),
    isError: /404|500|error/.test(lower),
    errorType: /404/.test(lower) ? '404' : null,
    isBlocked: /access denied|403|bot detected|cloudflare/.test(lower),
    isCaptcha: /captcha|recaptcha/.test(lower),
    interactiveElements: [],
    confidence: 0.4
  };
}

// ── Vision prompt (long — will be cached) ────────────────────────────────────
const VISION_PROMPT_TEMPLATE = (url) => `You are the "Eyes" of an autonomous procurement-tender-finding agent.

Analyse this webpage screenshot and page text. Report back what the agent needs to plan its next action.

Current URL: ${url}

Respond ONLY with valid JSON (no markdown, no comments):
{
  "summary": "<1-2 sentences: what kind of page is this>",
  "hasTenderList": <bool>,
  "tenderListDescription": "<where/how the list appears, or null>",
  "hasPagination": <bool>,
  "nextPageSelector": "<plain-English description of next-page control, or null>",
  "hasSearchBar": <bool>,
  "searchBarDescription": "<where and what the search bar says, or null>",
  "hasLoginWall": <bool>,
  "hasNavigationMenu": <bool>,
  "navigationLinks": ["<link text>"],
  "is404": <bool>,
  "isError": <bool>,
  "errorType": "<type or null>",
  "isBlocked": <bool>,
  "isCaptcha": <bool>,
  "interactiveElements": [
    {"type":"button|input|link|dropdown|other","description":"plain English","approximatePosition":"top-left|top-center|top-right|center|bottom|unknown","text":"visible text","likellyRelevant":true}
  ],
  "confidence": <0.0-1.0>
}`;

class PerceptionModule {
  /**
   * Full perception: screenshot + accessibility tree + text → structured percept
   */
  async perceive(page, currentUrl) {
    const [screenshot, accessibilityTree, rawText] = await Promise.all([
      takeScreenshot(page),
      buildAccessibilityTree(page),
      extractPageText(page)
    ]);

    // ── Prompt injection guard ────────────────────────────────────────────────
    if (detectPromptInjection(rawText)) {
      logger.warn(`  🛡️  Prompt injection attempt detected on ${currentUrl} — clamping percept`);
      return {
        url: currentUrl, screenshot, semanticContent: '[REDACTED: injection detected]',
        accessibilityTree, ...textOnlyFallback(''),
        injectionDetected: true
      };
    }

    const cleanText = stripHtmlNoise(rawText);
    const understanding = await this._visionUnderstand(screenshot, currentUrl, cleanText);

    return {
      url: currentUrl,
      screenshot,
      semanticContent: cleanText,
      accessibilityTree,
      injectionDetected: false,
      ...understanding
    };
  }

  /**
   * Vision LLM understanding — the core perceptual reasoning
   */
  async _visionUnderstand(screenshotBase64, url, pageText) {
    if (!screenshotBase64) return textOnlyFallback(pageText);

    const prompt = VISION_PROMPT_TEMPLATE(url) +
      `\n\nPage text preview (first 2000 chars):\n${pageText.substring(0, 2000)}`;

    const result = await callVision({
      prompt,
      screenshotBase64,
      schema: PerceptionSchema,
      fallback: textOnlyFallback(pageText),
      model: 'gpt-4o'
    });

    if (!result.success) {
      logger.warn(`  Vision schema validation failed — using text fallback`);
      return result.data; // Already the fallback
    }

    return result.data;
  }

  /**
   * Locate an element by semantic description — returns pixel coordinates
   */
  async locateElement(screenshotBase64, description) {
    const prompt = `Find this element on the webpage screenshot: "${description}"

If found, respond with ONLY JSON: {"found":true,"x":<px>,"y":<px>,"confidence":<0-1>}
If not found: {"found":false}
x=0,y=0 is top-left. Do not wrap in markdown.`;

    const result = await callVision({
      prompt,
      screenshotBase64,
      schema: ElementLocationSchema,
      fallback: { found: false },
      model: 'gpt-4o'
    });

    if (result.data?.found && result.data.confidence > 0.6) {
      logger.info(`    👁️  Vision located "${description}" at (${result.data.x}, ${result.data.y})`);
      return { x: result.data.x, y: result.data.y };
    }
    return null;
  }
}

// ── Page helpers ──────────────────────────────────────────────────────────────
async function takeScreenshot(page) {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false });
    return buf.toString('base64');
  } catch { return null; }
}

async function buildAccessibilityTree(page) {
  try {
    const tree = await page.accessibility.snapshot({ interestingOnly: true });
    return flattenTree(tree, 0).substring(0, 4000);
  } catch { return ''; }
}

function flattenTree(node, depth) {
  if (!node) return '';
  const indent = '  '.repeat(Math.min(depth, 4));
  let out = '';
  const relevant = ['button', 'link', 'heading', 'listitem', 'searchbox', 'textbox'];
  if (node.name && (relevant.includes(node.role) || depth < 2)) {
    out += `${indent}[${node.role}] ${node.name}\n`;
  }
  for (const child of (node.children || [])) out += flattenTree(child, depth + 1);
  return out;
}

async function extractPageText(page) {
  try {
    return await page.evaluate(() => {
      document.querySelectorAll('script,style,nav,footer,header,aside,.ad,.advertisement,.cookie-banner').forEach(el => el.remove());
      const main = document.querySelector('main,[role="main"],.content,.main-content') || document.body;
      return (main?.innerText || document.body.innerText || '').substring(0, 15000);
    });
  } catch { return ''; }
}

module.exports = { PerceptionModule };
