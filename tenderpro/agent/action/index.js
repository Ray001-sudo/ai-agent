/**
 * Action Module — The Agent's Hands
 * 
 * Executes browser actions using SEMANTIC descriptions, not CSS selectors.
 * When told to "click the blue button that says Next", it uses the vision LLM
 * to find that element by appearance, then acts on it.
 * 
 * Features:
 * - Human-like latency (random delays, mouse curves)
 * - Proxy rotation 
 * - Browser fingerprint randomization
 * - Vision-based element finding
 * - Resilient to layout changes
 */

const { chromium } = require('playwright');
const OpenAI = require('openai').default;
const { logger } = require('../utils/logger');
const { createCanvas } = require('canvas');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PROXY_LIST = (process.env.PROXY_LIST || '').split(',').filter(Boolean);
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
];

const VIEWPORT_SIZES = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 }
];

class ActionModule {
  constructor() {
    this.currentProxyIndex = 0;
    this.browserContexts = new Map();
  }

  async launchBrowser(options = {}) {
    const launchArgs = {
      headless: process.env.PUPPETEER_HEADLESS !== 'false',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-extensions',
        `--window-size=${VIEWPORT_SIZES[Math.floor(Math.random() * VIEWPORT_SIZES.length)].width},${VIEWPORT_SIZES[0].height}`
      ]
    };

    if (PROXY_LIST.length > 0 && options.useProxy) {
      launchArgs.proxy = { server: this._getNextProxy() };
    }

    return await chromium.launch(launchArgs);
  }

  async newPage(browser, options = {}) {
    const viewport = VIEWPORT_SIZES[Math.floor(Math.random() * VIEWPORT_SIZES.length)];
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    const context = await browser.newContext({
      viewport,
      userAgent,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      permissions: ['notifications'],
      // Randomize browser fingerprint
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'DNT': '1',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    const page = await context.newPage();

    // Mask automation signals
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    });

    if (options.humanLatency) {
      page._humanLatency = true;
    }

    return page;
  }

  async navigate(page, url) {
    logger.info(`    ↗️ Navigate: ${url}`);
    if (page._humanLatency) await this._humanPause(500, 1500);

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    // Wait for page to settle (human-like reading pause)
    if (page._humanLatency) await this._humanPause(1500, 4000);
    await this._waitForPageIdle(page);
  }

  /**
   * Semantic click — finds an element by its DESCRIPTION, not CSS selector
   * Uses vision LLM to locate the element if accessibility tree fails
   */
  async semanticClick(page, elementDescription, fallbackDescription = null) {
    logger.info(`    👆 Semantic click: "${elementDescription}"`);

    // Strategy 1: Accessibility tree search
    const ariaResult = await this._findByAccessibility(page, elementDescription);
    if (ariaResult) {
      await this._humanMouseMove(page, ariaResult);
      await ariaResult.click();
      if (page._humanLatency) await this._humanPause(800, 2000);
      return;
    }

    // Strategy 2: Text content search
    const textResult = await this._findByText(page, elementDescription);
    if (textResult) {
      await this._humanMouseMove(page, textResult);
      await textResult.click();
      if (page._humanLatency) await this._humanPause(800, 2000);
      return;
    }

    // Strategy 3: Vision LLM — take screenshot and ask where to click
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
    const coordinates = await this._visionLocateElement(screenshot, elementDescription);

    if (coordinates) {
      await page.mouse.move(coordinates.x + (Math.random() * 6 - 3), coordinates.y + (Math.random() * 6 - 3));
      await this._humanPause(100, 300);
      await page.mouse.click(coordinates.x, coordinates.y);
      if (page._humanLatency) await this._humanPause(800, 2000);
      return;
    }

    // Strategy 4: Try fallback description
    if (fallbackDescription) {
      return await this.semanticClick(page, fallbackDescription);
    }

    throw new Error(`Could not find element: "${elementDescription}"`);
  }

  /**
   * Use vision LLM to find element coordinates
   */
  async _visionLocateElement(screenshotBase64, elementDescription) {
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Find this element on the webpage screenshot: "${elementDescription}"
              
If found, respond with ONLY JSON: {"found": true, "x": <pixel_x>, "y": <pixel_y>, "confidence": <0-1>}
If not found: {"found": false}

The image is the current state of the webpage. x=0,y=0 is top-left.`
            },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}`, detail: 'high' } }
          ]
        }]
      });

      const result = JSON.parse(response.choices[0].message.content.trim());
      if (result.found && result.confidence > 0.6) {
        logger.info(`    👁️ Vision located element at (${result.x}, ${result.y}), confidence: ${result.confidence}`);
        return { x: result.x, y: result.y };
      }
    } catch (e) {
      logger.warn(`Vision element location failed: ${e.message}`);
    }
    return null;
  }

  async _findByAccessibility(page, description) {
    try {
      const keywords = description.toLowerCase().split(' ').filter(w => w.length > 2);
      const selectors = [
        `role=button[name*="${keywords[0]}"]`,
        `role=link[name*="${keywords[0]}"]`,
        `[aria-label*="${keywords[0]}"]`
      ];

      for (const selector of selectors) {
        const el = page.locator(selector).first();
        if (await el.isVisible().catch(() => false)) return el;
      }
    } catch (e) {}
    return null;
  }

  async _findByText(page, description) {
    try {
      const keywords = description.toLowerCase().split(' ').filter(w => w.length > 3);
      for (const keyword of keywords.slice(0, 3)) {
        const el = page.locator(`text="${keyword}"`).first();
        if (await el.isVisible().catch(() => false)) return el;

        const partial = page.locator(`text=/${keyword}/i`).first();
        if (await partial.isVisible().catch(() => false)) return partial;
      }
    } catch (e) {}
    return null;
  }

  async typeInField(page, fieldDescription, text) {
    logger.info(`    ⌨️ Type in "${fieldDescription}": "${text}"`);

    const field = await this._findByAccessibility(page, fieldDescription) ||
                  await this._findByText(page, fieldDescription);

    if (field) {
      await field.click();
      await this._humanPause(200, 500);
      // Type like a human — random delays between keystrokes
      await field.fill('');
      for (const char of text) {
        await field.type(char, { delay: 50 + Math.random() * 100 });
      }
      return;
    }

    // Vision fallback
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
    const coords = await this._visionLocateElement(screenshot, fieldDescription);
    if (coords) {
      await page.mouse.click(coords.x, coords.y);
      await page.keyboard.type(text, { delay: 80 + Math.random() * 120 });
    }
  }

  async performSearch(page, query) {
    logger.info(`    🔍 Search: "${query}"`);

    // Try common search patterns
    const searchSelectors = [
      { description: 'search input box or search bar' },
      { description: 'field labeled "Search" or "Find"' }
    ];

    for (const sel of searchSelectors) {
      try {
        await this.typeInField(page, sel.description, query);
        await this._humanPause(300, 600);
        await page.keyboard.press('Enter');
        await this._humanPause(1500, 3000);
        await this._waitForPageIdle(page);
        return;
      } catch (e) {}
    }

    throw new Error('Could not find search field');
  }

  async scrollDown(page) {
    if (page._humanLatency) await this._humanPause(500, 1000);
    await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'smooth' }));
    await this._humanPause(800, 1500);
  }

  async closeModal(page) {
    const closePatterns = [
      'button that closes or dismisses a dialog',
      'X or close button on a popup',
      'button saying Close or Cancel'
    ];

    for (const pattern of closePatterns) {
      try {
        await this.semanticClick(page, pattern);
        return;
      } catch (e) {}
    }

    // Try pressing Escape
    await page.keyboard.press('Escape');
  }

  async downloadAndAnalyzePDF(page, url) {
    const response = await page.context().request.get(url, {
      headers: { 'User-Agent': USER_AGENTS[0] }
    });
    const buffer = await response.body();
    return { buffer, url };
  }

  async rotateBrowser(browser, page) {
    logger.info('  🔄 Rotating browser identity...');
    await this._humanPause(3000, 8000); // Back off before retry
    this.currentProxyIndex++;
    // Note: browser/page rotation happens in the calling code
  }

  async _waitForPageIdle(page, timeout = 5000) {
    try {
      await page.waitForLoadState('networkidle', { timeout });
    } catch (e) {
      // Non-critical — page may still be loading ads/analytics
    }
  }

  async _humanMouseMove(page, element) {
    if (!page._humanLatency) return;
    try {
      const box = await element.boundingBox();
      if (box) {
        // Move in a curved path (human-like)
        const targetX = box.x + box.width / 2 + (Math.random() * 10 - 5);
        const targetY = box.y + box.height / 2 + (Math.random() * 10 - 5);
        await page.mouse.move(targetX, targetY, { steps: 10 });
        await this._humanPause(100, 300);
      }
    } catch (e) {}
  }

  _humanPause(min, max) {
    const ms = min + Math.random() * (max - min);
    return new Promise(r => setTimeout(r, ms));
  }

  _getNextProxy() {
    if (PROXY_LIST.length === 0) return null;
    const proxy = PROXY_LIST[this.currentProxyIndex % PROXY_LIST.length];
    this.currentProxyIndex++;
    return proxy;
  }
}

module.exports = { ActionModule };
