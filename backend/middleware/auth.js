'use strict';
/**
 * TenderPro — All Middleware
 *
 * auth          verify JWT from Authorization header or httpOnly cookie
 * loadUser      attach full user+company, set req.companyId (isolation key)
 * trialGuard    block expired trials
 * quotaGuard    enforce daily search / monthly alert limits per plan
 * featureGuard  block premium features on free plans
 * adminOnly     secret admin gate (IP + header + role)
 * companyFilter helper to always scope queries to req.companyId
 */

const jwt        = require('jsonwebtoken');
const Bottleneck = require('bottleneck');
const { User }   = require('../models');
const { logger } = require('../utils/logger');

// ── Plan quotas — single source of truth ──────────────────────────────────────
const PLANS = {
  trial:        { dailySearches: 3,  monthlyAlerts: 10,  draftEnabled: false, calendarEnabled: false },
  free:         { dailySearches: 2,  monthlyAlerts: 5,   draftEnabled: false, calendarEnabled: false },
  starter:      { dailySearches: 10, monthlyAlerts: 20,  draftEnabled: false, calendarEnabled: false },
  professional: { dailySearches: 50, monthlyAlerts: 100, draftEnabled: true,  calendarEnabled: true  },
  enterprise:   { dailySearches: -1, monthlyAlerts: -1,  draftEnabled: true,  calendarEnabled: true  }
};
module.exports.PLANS = PLANS;

// ── Per-user DB limiter (prevents one user hammering Mongo) ───────────────────
const dbLimiter = new Bottleneck({ maxConcurrent: 20, minTime: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// auth — verify JWT from Bearer header OR httpOnly cookie
// Fixes the "refresh-on-login" bug: token is set BOTH in cookie and header
// so the browser never needs to manually attach it after redirect.
// ─────────────────────────────────────────────────────────────────────────────
module.exports.auth = (req, res, next) => {
  // 1. Try Authorization header (API clients / mobile)
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;

  // 2. Try httpOnly cookie (browser SPA — survives page refresh)
  if (!token && req.cookies?.tp_token) {
    token = req.cookies.tp_token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    // Clear bad cookie
    res.clearCookie('tp_token');
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// loadUser — attach full user + company
// Sets req.companyId which MUST be used in every DB query for isolation
// ─────────────────────────────────────────────────────────────────────────────
module.exports.loadUser = async (req, res, next) => {
  try {
    const user = await dbLimiter.schedule(() =>
      User.findById(req.user.id).select('-password -whatsappOtp').populate('company')
    );

    if (!user)         return res.status(404).json({ error: 'User not found' });
    if (!user.company) return res.status(403).json({ error: 'No company linked to account' });

    req.userDoc   = user;
    req.companyId = user.company._id.toString(); // isolation key — always use this
    next();
  } catch (e) {
    logger.error('loadUser:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// trialGuard — blocks expired trials
// ─────────────────────────────────────────────────────────────────────────────
module.exports.trialGuard = (req, res, next) => {
  const sub  = req.userDoc?.subscription;
  const plan = sub?.plan || 'trial';

  if (['starter', 'professional', 'enterprise'].includes(plan)) return next();

  if (sub?.trialEndsAt && new Date() > new Date(sub.trialEndsAt)) {
    return res.status(402).json({
      error:      'trial_expired',
      message:    'Your 3-day free trial has ended. Upgrade to continue.',
      upgradeUrl: `${process.env.FRONTEND_URL}/upgrade`
    });
  }
  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// quotaGuard — daily search / monthly alert enforcement
// Usage: router.post('/search', auth, loadUser, quotaGuard('search'), handler)
// ─────────────────────────────────────────────────────────────────────────────
module.exports.quotaGuard = (action = 'search') => async (req, res, next) => {
  try {
    const plan  = req.userDoc?.subscription?.plan || 'trial';
    const quota = PLANS[plan];
    const limit = action === 'search' ? quota.dailySearches : quota.monthlyAlerts;
    if (limit === -1) return next(); // unlimited

    const today  = new Date().toISOString().slice(0, 10);
    const month  = today.slice(0, 7);
    const isSearch = action === 'search';

    const user = await User.findById(req.user.id).select('quota');
    const savedDate = isSearch ? user.quota?.searchDate : user.quota?.alertMonth;
    const resetValue = isSearch ? today : month;

    let used = 0;
    if (savedDate !== resetValue) {
      // New period — reset counter
      const resetUpdate = isSearch
        ? { 'quota.searchesToday': 0, 'quota.searchDate': resetValue }
        : { 'quota.alertsThisMonth': 0, 'quota.alertMonth': resetValue };
      await User.findByIdAndUpdate(req.user.id, { $set: resetUpdate });
    } else {
      used = isSearch ? (user.quota?.searchesToday || 0) : (user.quota?.alertsThisMonth || 0);
    }

    if (used >= limit) {
      return res.status(429).json({
        error:       'quota_exceeded',
        message:     `You've used all ${limit} ${action}${limit === 1 ? '' : 's'} for today on the ${plan} plan.`,
        used, limit, plan,
        upgradeUrl:  `${process.env.FRONTEND_URL}/upgrade`,
        resetsAt:    isSearch ? 'midnight UTC' : 'next month'
      });
    }

    // Increment
    const incUpdate = isSearch
      ? { $inc: { 'quota.searchesToday': 1 } }
      : { $inc: { 'quota.alertsThisMonth': 1 } };
    await User.findByIdAndUpdate(req.user.id, incUpdate);

    req.quotaRemaining = limit - used - 1;
    next();
  } catch (e) {
    logger.error('quotaGuard:', e.message);
    next(); // fail open — never block on quota errors
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// featureGuard — lock premium features
// Usage: featureGuard('draftEnabled')
// ─────────────────────────────────────────────────────────────────────────────
module.exports.featureGuard = (feature) => (req, res, next) => {
  const plan    = req.userDoc?.subscription?.plan || 'trial';
  const allowed = PLANS[plan]?.[feature] === true;
  if (!allowed) {
    return res.status(403).json({
      error:      'feature_locked',
      feature,
      plan,
      message:    `${feature} requires a paid plan. Current: ${plan}.`,
      upgradeUrl: `${process.env.FRONTEND_URL}/upgrade`
    });
  }
  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// adminOnly — secret admin gate
// 3-layer: X-Admin-Key header + IP whitelist + superadmin role
// Returns 404 for every unauthorized attempt (route existence not revealed)
// ─────────────────────────────────────────────────────────────────────────────
module.exports.adminOnly = async (req, res, next) => {
  try {
    // Layer 1: secret header
    if (req.headers['x-admin-key'] !== process.env.ADMIN_SECRET_KEY) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Layer 2: IP whitelist
    const allowedIPs = (process.env.ADMIN_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowedIPs.length > 0 && !allowedIPs.includes('*')) {
      const ip = (req.ip || '').replace('::ffff:', '');
      if (!allowedIPs.includes(ip)) {
        logger.warn(`Admin denied for IP: ${ip}`);
        return res.status(404).json({ error: 'Not found' });
      }
    }

    // Layer 3: JWT + superadmin role
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : req.cookies?.tp_admin_token;
    if (!token) return res.status(404).json({ error: 'Not found' });

    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(404).json({ error: 'Not found' }); }

    const user = await User.findById(decoded.id).select('-password');
    if (!user || user.role !== 'superadmin') return res.status(404).json({ error: 'Not found' });

    req.admin = user;
    logger.info(`Admin access: ${user.email} from ${req.ip}`);
    next();
  } catch (e) {
    logger.error('adminOnly:', e.message);
    return res.status(404).json({ error: 'Not found' });
  }
};

// ── companyFilter — always scope queries to current user's company ─────────────
module.exports.companyFilter = (req) => ({ company: req.companyId });
