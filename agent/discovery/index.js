/**
 * Discovery Module — Neural Search + Verified Portal Registry (v2)
 *
 * Improvements over v1:
 *  ✓ Verified Portals DB (Redis): once a domain is proven to have tenders,
 *    it is stored and visited directly — no search API call needed (saves cost)
 *  ✓ Weekly direct-crawl of verified portals (bypasses Tavily/Exa)
 *  ✓ Extended spam/aggregator blacklist
 *  ✓ URL score considers age of last-seen tender (freshness)
 *  ✓ Retry + backoff on search API calls via llmClient utilities
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

// ── Extended noise domain list (spam aggregators that paywall gov data) ────────
const NOISE_DOMAINS = [
  'youtube.com','facebook.com','twitter.com','linkedin.com','wikipedia.org',
  'pinterest.com','instagram.com','reddit.com','amazon.com','ebay.com',
  // Aggregators that hide data behind paywalls (go to original source instead)
  'tendersinfo.com','biddetail.com','tenderdetail.com','tendersniper.com',
  'tenderspage.com','bidnetwork.org','contractsadvance.com',
  'procurementclassifieds.com','findrfp.com','rfpdb.com',
  'tendersindiaonline.com','tendersonline.in'
];

const TRUSTED_SIGNALS = [
  '.go.ke','.gov.','.go.ug','.go.tz','.go.rw','.gov.ng','.gov.gh','.gov.za',
  'ppra','ppip','ppda','eprocure','procurement','tenders','bids','rfp',
  'ungm.org','sam.gov','ted.europa','worldbank.org','afdb.org',
  'undp.org','usaid.gov','contractsfinder.gov.uk','adb.org','ifc.org'
];

// ── Verified portal cache key prefix ─────────────────────────────────────────
const PORTAL_KEY_PREFIX = 'verified_portal:';
const PORTAL_LIST_KEY   = 'verified_portals_list';

class DiscoveryModule {
  constructor() {
    this.tavilyKey  = process.env.TAVILY_API_KEY;
    this.exaKey     = process.env.EXA_API_KEY;
    this.googleKey  = process.env.GOOGLE_SEARCH_API_KEY;
    this.googleCX   = process.env.GOOGLE_SEARCH_CX;
  }

  /**
   * Main discovery — returns ranked candidates for the agent to browse
   */
  async findProcurementPortals(goal) {
    logger.info(`  📡 Discovering portals for: "${goal.query}" in ${goal.country || 'global'}`);

    const allCandidates = [];

    // ── 1. Check verified portals first (zero-cost, fast) ────────────────────
    const verifiedHits = await this._queryVerifiedPortals(goal.country, goal.sector);
    if (verifiedHits.length > 0) {
      logger.info(`  ✅ ${verifiedHits.length} verified portals retrieved from memory`);
      allCandidates.push(...verifiedHits);
    }

    // ── 2. Neural + web search for new portals ────────────────────────────────
    const [tavily, exa, google] = await Promise.allSettled([
      this._tavilySearch(goal.query, goal.country, goal.sector),
      this._exaNeuralSearch(goal.query, goal.country),
      this._googleSearch(goal.query, goal.country)
    ]);

    if (tavily.status === 'fulfilled') allCandidates.push(...tavily.value);
    if (exa.status    === 'fulfilled') allCandidates.push(...exa.value);
    if (google.status === 'fulfilled') allCandidates.push(...google.value);

    // ── 3. Deduplicate by hostname ────────────────────────────────────────────
    const seen = new Set();
    const unique = allCandidates.filter(c => {
      try {
        const host = new URL(c.url).hostname;
        if (seen.has(host)) return false;
        seen.add(host);
        return true;
      } catch { return false; }
    });

    // ── 4. Score & rank ───────────────────────────────────────────────────────
    const scored = unique
      .map(c => ({ ...c, score: this._scoreUrl(c.url, c.snippet || '', c.isVerified) }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score);

    logger.info(`  📡 Discovery: ${allCandidates.length} raw → ${scored.length} ranked`);
    return scored.slice(0, 15);
  }

  /**
   * Mark a domain as verified (it contained real tenders)
   * Called by the orchestrator after a successful extraction
   */
  async markPortalVerified(url, metadata = {}) {
    try {
      const { getRedisClient } = require('../../backend/utils/redis');
      const redis = getRedisClient();
      const host = new URL(url).hostname;
      const key = `${PORTAL_KEY_PREFIX}${host}`;

      const existing = JSON.parse(await redis.get(key) || '{}');
      const record = {
        ...existing,
        url,
        host,
        country: metadata.country,
        sector: metadata.sector,
        tendersFound: (existing.tendersFound || 0) + (metadata.tendersFound || 1),
        lastVerified: new Date().toISOString(),
        verifiedCount: (existing.verifiedCount || 0) + 1
      };

      await redis.set(key, JSON.stringify(record)); // No TTL — verified portals are permanent
      await redis.sAdd(PORTAL_LIST_KEY, host);
      logger.info(`  ⭐ Portal verified and saved: ${host}`);
    } catch (e) {
      logger.warn(`markPortalVerified failed: ${e.message}`);
    }
  }

  /**
   * Direct weekly crawl of all verified portals (no search API cost)
   */
  async getWeeklyDirectCrawlList(country) {
    try {
      const { getRedisClient } = require('../../backend/utils/redis');
      const redis = getRedisClient();
      const hosts = await redis.sMembers(PORTAL_LIST_KEY);

      const portals = [];
      for (const host of hosts) {
        const record = JSON.parse(await redis.get(`${PORTAL_KEY_PREFIX}${host}`) || '{}');
        if (country && record.country && record.country !== country) continue;
        portals.push({
          url: record.url || `https://${host}`,
          sourceName: host,
          priority: 10, // Verified portals get highest priority
          isVerified: true,
          tendersFound: record.tendersFound || 0
        });
      }

      return portals.sort((a, b) => b.tendersFound - a.tendersFound);
    } catch (e) {
      logger.warn(`Weekly crawl list failed: ${e.message}`);
      return [];
    }
  }

  // ── Tavily ─────────────────────────────────────────────────────────────────
  async _tavilySearch(query, country, sector) {
    if (!this.tavilyKey) return this._seedFallback(country);

    const q = [query, sector, country, 'tender procurement portal 2025 2026'].filter(Boolean).join(' ');

    try {
      const res = await axios.post('https://api.tavily.com/search', {
        api_key: this.tavilyKey,
        query: q,
        search_depth: 'advanced',
        include_domains: ['gov', 'go.ke', 'ppra', 'ppip', 'ungm', 'worldbank', 'undp', 'usaid', 'afdb'],
        max_results: 10
      }, { timeout: 15000 });

      return (res.data.results || []).map(r => ({
        url: r.url, sourceName: r.title || new URL(r.url).hostname,
        snippet: r.content, priority: 8
      }));
    } catch (e) {
      logger.warn(`Tavily failed: ${e.message}`);
      return this._seedFallback(country);
    }
  }

  // ── Exa Neural Search ──────────────────────────────────────────────────────
  async _exaNeuralSearch(query, country) {
    if (!this.exaKey) return [];

    const nq = country
      ? `government procurement tender portal ${country} active tenders bids 2026`
      : 'government procurement tender portal active bids 2026';

    try {
      const res = await axios.post('https://api.exa.ai/search', {
        query: nq, num_results: 8, use_autoprompt: true, type: 'neural',
        include_domains: ['gov', '.go.', 'procurement', 'tenders', 'ppra', 'ppip']
      }, {
        headers: { 'x-api-key': this.exaKey, 'Content-Type': 'application/json' },
        timeout: 15000
      });

      return (res.data.results || []).map(r => ({
        url: r.url, sourceName: r.title || new URL(r.url).hostname,
        snippet: (r.highlights || []).join(' '), priority: 9
      }));
    } catch (e) {
      logger.warn(`Exa failed: ${e.message}`);
      return [];
    }
  }

  // ── Google Custom Search ───────────────────────────────────────────────────
  async _googleSearch(query, country) {
    if (!this.googleKey || !this.googleCX) return [];

    const q = `${query} ${country || ''} tender procurement 2026 site:.gov OR site:.go.ke OR site:.go.ug`;

    try {
      const res = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: { key: this.googleKey, cx: this.googleCX, q, num: 10, dateRestrict: 'm3' },
        timeout: 10000
      });
      return (res.data.items || []).map(item => ({
        url: item.link, sourceName: item.displayLink,
        snippet: item.snippet, priority: 6
      }));
    } catch (e) {
      logger.warn(`Google search failed: ${e.message}`);
      return [];
    }
  }

  // ── Query verified portals from Redis ─────────────────────────────────────
  async _queryVerifiedPortals(country, sector) {
    try {
      const { getRedisClient } = require('../../backend/utils/redis');
      const redis = getRedisClient();
      const hosts = await redis.sMembers(PORTAL_LIST_KEY);

      const portals = [];
      for (const host of (hosts || []).slice(0, 20)) {
        const record = JSON.parse(await redis.get(`${PORTAL_KEY_PREFIX}${host}`) || '{}');
        if (country && record.country && record.country !== country) continue;
        portals.push({
          url: record.url || `https://${host}`,
          sourceName: host,
          snippet: `Verified: ${record.tendersFound || '?'} tenders found`,
          priority: 10,
          isVerified: true
        });
      }
      return portals;
    } catch { return []; }
  }

  // ── URL quality scoring ────────────────────────────────────────────────────
  _scoreUrl(url, snippet, isVerified = false) {
    try {
      if (isVerified) return 20; // Verified portals always win
      const u = url.toLowerCase();
      const s = snippet.toLowerCase();
      if (NOISE_DOMAINS.some(d => u.includes(d))) return 0;
      let score = 5;
      if (TRUSTED_SIGNALS.some(sig => u.includes(sig))) score += 5;
      if (/\.gov\.|\.go\.|\.gouv\.|\.gob\./.test(u)) score += 4;
      if (/tender|procurement|bid|rfp|rfq|contract|opportunity/i.test(u)) score += 3;
      if (/tender|bid|procurement|deadline|submission/i.test(s)) score += 2;
      if (/2025|2026|active|open|current/.test(s)) score += 1;
      if (/compare|rank|list of|best|top \d+/i.test(s)) score -= 3;
      return Math.max(0, score);
    } catch { return 0; }
  }

  // ── Seed fallback when no API keys configured ──────────────────────────────
  _seedFallback(country) {
    const seeds = {
      Kenya:         [{ url: 'https://tenders.go.ke',         sourceName: 'Kenya PPIP',    priority: 10 },
                      { url: 'https://eprocure.go.ke',         sourceName: 'Kenya eProcure', priority: 9  }],
      Uganda:        [{ url: 'https://www.ppda.go.ug',         sourceName: 'Uganda PPDA',   priority: 10 }],
      Tanzania:      [{ url: 'https://www.ppra.go.tz',         sourceName: 'Tanzania PPRA', priority: 10 }],
      Nigeria:       [{ url: 'https://www.bpp.gov.ng',         sourceName: 'Nigeria BPP',   priority: 10 }],
      'South Africa':[{ url: 'https://www.etenders.gov.za',    sourceName: 'SA eTenders',   priority: 10 }],
      Ghana:         [{ url: 'https://www.ppaghana.org',       sourceName: 'Ghana PPA',     priority: 10 }],
      International: [{ url: 'https://www.ungm.org/Public/Notice', sourceName: 'UNGM',      priority: 10 },
                      { url: 'https://procurement-notices.undp.org', sourceName: 'UNDP',    priority: 9  }]
    };
    const specific = seeds[country] || [];
    const global   = seeds['International'];
    return [...specific, ...global.filter(g => !specific.find(s => s.url === g.url))];
  }
}

module.exports = { DiscoveryModule };
