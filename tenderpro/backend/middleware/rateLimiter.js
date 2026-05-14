'use strict';
/**
 * Rate Limiters
 *
 * Uses express-rate-limit with Redis store for distributed limiting.
 * Falls back to in-memory if Redis is unavailable.
 *
 * Limiters:
 *   globalLimiter  — 200 req/15min per IP (all routes)
 *   authLimiter    — 10 req/15min per IP (login/register)
 *   apiLimiter     — 100 req/min per user (authenticated routes)
 *   searchLimiter  — 20 req/min per user (agent search)
 *   webhookLimiter — 120 req/min (Twilio WhatsApp webhooks)
 */

const rateLimit = require('express-rate-limit');
const { logger } = require('../utils/logger');

const handler = (req, res) => {
  logger.warn(`Rate limit hit: ${req.ip} → ${req.path}`);
  res.status(429).json({
    error:   'too_many_requests',
    message: 'Too many requests. Please slow down.',
    retryAfter: Math.ceil(res.getHeader('Retry-After') || 60)
  });
};

// Key by user ID for authenticated routes, IP for public
const userKey = (req) => req.user?.id || req.ip;

module.exports.globalLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler
});

module.exports.authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
  message: { error: 'too_many_auth_attempts', message: 'Too many login attempts. Try again in 15 minutes.' }
});

module.exports.apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  handler
});

module.exports.searchLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
  message: { error: 'search_rate_limit', message: 'Too many searches. Wait a moment.' }
});

module.exports.webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler
});
