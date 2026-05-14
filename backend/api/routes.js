'use strict';
const express  = require('express');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { body, validationResult } = require('express-validator');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { google } = require('googleapis');

const { auth, loadUser, trialGuard, quotaGuard, featureGuard, companyFilter, PLANS } = require('../middleware/auth');
const { apiLimiter, authLimiter, searchLimiter } = require('../middleware/rateLimiter');
const { User, Company, Tender, TenderMatch, Proposal, Payment } = require('../models');
const { RAGService }        = require('../../agent/rag/ragService');
const { callAnthropic }     = require('../../agent/core/llmClient');
const { AgentOrchestrator } = require('../../agent/orchestrator');
const { handleMpesaCallback, initiateStripePayment, initiateMpesaPayment, activateSubscription } = require('../services/paymentService');
const { createCalendarEvent, sendEmail } = require('../services/allServices');
const { sendWhatsAppMessage } = require('../whatsapp/whatsAppClient');
const { logger } = require('../utils/logger');

const ragService = new RAGService();

// ── Upload dir ────────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.resolve(process.env.LOCAL_STORAGE_PATH || './uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 50) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.txt', '.docx', '.doc'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only PDF, TXT, DOCX files allowed'), ok);
  }
});

// ── Cookie helper — set secure httpOnly cookie ─────────────────────────────────
function setAuthCookie(res, token) {
  res.cookie('tp_token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   7 * 24 * 3600_000 // 7 days
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────
const authRouter = express.Router();
authRouter.use(authLimiter);

authRouter.post('/register',
  [body('email').isEmail(), body('password').isLength({ min: 8 }), body('name').trim().notEmpty(), body('phone').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, password, phone, companyName, sectors = [], targetCountries = [] } = req.body;

    if (await User.findOne({ email: email.toLowerCase().trim() }))
      return res.status(409).json({ error: 'Email already registered' });

    const ns      = `co-${crypto.randomBytes(8).toString('hex')}`;
    const trialEnd = new Date(Date.now() + 3 * 24 * 3600_000);

    const company = await Company.create({
      name: companyName || `${name}'s Company`,
      industry: sectors, services: sectors,
      knowledgeBase: { vectorNamespace: ns },
      tenderPreferences: { sectors },
      targetLocations: targetCountries.map(c => ({ country: c })),
      plan: 'trial'
    });

    const user = await User.create({
      name, email: email.toLowerCase().trim(), phone,
      password: await bcrypt.hash(password, 12),
      company: company._id,
      subscription: { plan: 'trial', status: 'trial', trialEndsAt: trialEnd }
    });

    ragService.indexCompanyProfile(company._id).catch(() => {});

    const token = jwt.sign({ id: user._id, company: company._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);

    res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone, subscription: user.subscription },
      company: { id: company._id, name: company.name, plan: company.plan },
      trial: { endsAt: trialEnd, daysLeft: 3 }
    });
  }
);

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = await User.findOne({ email: email.toLowerCase().trim() }).populate('company');
  if (!user || !await bcrypt.compare(password, user.password))
    return res.status(401).json({ error: 'Invalid email or password' });

  // Check trial expiry
  const sub  = user.subscription;
  let trialExpired = false;
  if (sub.plan === 'trial' && sub.trialEndsAt && new Date() > new Date(sub.trialEndsAt)) {
    trialExpired = true;
  }

  await User.findByIdAndUpdate(user._id, { lastActive: new Date() });

  const token = jwt.sign({ id: user._id, company: user.company._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

  // Set cookie — fixes refresh-on-login bug for SPA
  setAuthCookie(res, token);

  const trialDaysLeft = sub.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt) - Date.now()) / 86_400_000))
    : 0;

  res.json({
    token,
    user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, preferences: user.preferences, subscription: user.subscription },
    company: { id: user.company._id, name: user.company.name, plan: user.company.plan },
    trialExpired,
    trialDaysLeft
  });
});

authRouter.post('/logout', (req, res) => {
  res.clearCookie('tp_token');
  res.json({ success: true });
});

authRouter.get('/me', auth, loadUser, (req, res) => {
  const u = req.userDoc;
  const trialDaysLeft = u.subscription?.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(u.subscription.trialEndsAt) - Date.now()) / 86_400_000))
    : 0;
  res.json({
    id: u._id, name: u.name, email: u.email, phone: u.phone,
    role: u.role, preferences: u.preferences, subscription: u.subscription,
    company: { id: u.company._id, name: u.company.name, plan: u.company.plan },
    trialDaysLeft,
    quota: u.quota,
    planLimits: PLANS[u.subscription?.plan || 'trial']
  });
});

// WhatsApp OTP — send 6-digit code to verify number
authRouter.post('/whatsapp/send-otp', auth, loadUser, async (req, res) => {
  const otp     = Math.floor(100000 + Math.random() * 900000).toString();
  const expiry  = new Date(Date.now() + 10 * 60_000); // 10 min

  await User.findByIdAndUpdate(req.user.id, {
    whatsappOtp: await bcrypt.hash(otp, 10),
    whatsappOtpExpiry: expiry
  });

  try {
    await sendWhatsAppMessage(req.userDoc.phone,
      `🔐 *TenderPro Verification*\n\nYour OTP: *${otp}*\nExpires in 10 minutes.\n\n_Do not share this code._`
    );
    res.json({ success: true, message: 'OTP sent to your WhatsApp number' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send OTP. Check your WhatsApp number.' });
  }
});

// WhatsApp OTP — verify
authRouter.post('/whatsapp/verify-otp', auth, loadUser, async (req, res) => {
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ error: 'OTP required' });

  const user = await User.findById(req.user.id).select('+whatsappOtp +whatsappOtpExpiry');
  if (!user.whatsappOtp) return res.status(400).json({ error: 'No OTP pending. Request a new one.' });
  if (new Date() > user.whatsappOtpExpiry) return res.status(400).json({ error: 'OTP expired. Request a new one.' });

  const valid = await bcrypt.compare(otp, user.whatsappOtp);
  if (!valid) return res.status(400).json({ error: 'Invalid OTP' });

  await User.findByIdAndUpdate(req.user.id, {
    whatsappVerified: true,
    whatsappConnectedAt: new Date(),
    whatsappOtp: null,
    whatsappOtpExpiry: null,
    'preferences.notifyViaWhatsApp': true
  });

  res.json({ success: true, message: 'WhatsApp number verified! You will now receive tender alerts.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// TENDER ROUTES
// ─────────────────────────────────────────────────────────────────────────────
const tenderRouter = express.Router();
tenderRouter.use(auth, loadUser, trialGuard, apiLimiter);

tenderRouter.get('/', async (req, res) => {
  const { page = 1, limit = 20, country, sector, status = 'active' } = req.query;
  const q = { status };
  if (country) q['location.country'] = new RegExp(country, 'i');
  if (sector)  q.sector = new RegExp(sector, 'i');

  const [tenders, total] = await Promise.all([
    Tender.find(q).sort({ scrapedAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit)),
    Tender.countDocuments(q)
  ]);
  res.json({ tenders, total, page: parseInt(page), pages: Math.ceil(total / limit) });
});

// Matches — STRICT isolation: always filtered by req.companyId
tenderRouter.get('/matches', async (req, res) => {
  const { page = 1, limit = 20, minScore = 40 } = req.query;
  const filter = { ...companyFilter(req), matchScore: { $gte: parseInt(minScore) } };

  const matches = await TenderMatch.find(filter)
    .populate('tender')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  res.json({ matches, quotaRemaining: req.quotaRemaining });
});

tenderRouter.get('/matches/:matchId', async (req, res) => {
  // companyFilter ensures a user can ONLY fetch their own matches
  const match = await TenderMatch.findOne({ _id: req.params.matchId, ...companyFilter(req) }).populate('tender');
  if (!match) return res.status(404).json({ error: 'Not found' });
  res.json(match);
});

tenderRouter.get('/:id', async (req, res) => {
  const tender = await Tender.findById(req.params.id);
  if (!tender) return res.status(404).json({ error: 'Not found' });
  res.json(tender);
});

// Agent search — quota + rate limited
tenderRouter.post('/search/agent', searchLimiter, quotaGuard('search'), async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: 'Query required' });

  res.json({
    message: 'Agent search started',
    status: 'running',
    quotaRemaining: req.quotaRemaining,
    processingMessage: 'Your search is being processed. Results will appear in your matches shortly.'
  });

  setImmediate(async () => {
    try {
      const io   = req.app.get('io');
      const orch = req.app.get('orchestrator') || new AgentOrchestrator(io);
      await orch.scoutOnDemand(req.companyId, query);
    } catch (e) {
      logger.error('Agent search error:', e.message);
    }
  });
});

// Feedback — isolated to user's company
tenderRouter.post('/:matchId/feedback', async (req, res) => {
  const { action, reason } = req.body;
  const match = await TenderMatch.findOneAndUpdate(
    { _id: req.params.matchId, ...companyFilter(req) },
    { $push: { userActions: { userId: req.user.id, action, reason, timestamp: new Date() } } },
    { new: true }
  );
  if (!match) return res.status(404).json({ error: 'Not found' });

  // Update company feedback for ML learning
  await Company.findByIdAndUpdate(req.companyId, {
    $push: { feedback: { tenderId: match.tender, action, reason } }
  });

  if (action === 'won') {
    const full = await TenderMatch.findById(match._id).populate('tender');
    if (full?.tender) {
      await Company.findByIdAndUpdate(req.companyId, {
        $push: { pastBids: { tenderTitle: full.tender.title, won: true, year: new Date().getFullYear(), sector: full.tender.sector, country: full.tender.location?.country, value: full.tender.financials?.estimatedValue, currency: full.tender.financials?.currency } }
      });
    }
  }
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPANY ROUTES
// ─────────────────────────────────────────────────────────────────────────────
const companyRouter = express.Router();
companyRouter.use(auth, loadUser);

companyRouter.get('/profile', (req, res) => res.json(req.userDoc.company));

companyRouter.put('/profile', async (req, res) => {
  const allowed = ['name','description','website','services','industry','yearsFounded','certifications','tenderPreferences','targetLocations','pastBids','locations'];
  const upd = {}; allowed.forEach(k => { if (req.body[k] !== undefined) upd[k] = req.body[k]; });
  upd.updatedAt = new Date();

  // ISOLATED: can only update own company
  const updated = await Company.findOneAndUpdate({ _id: req.companyId }, upd, { new: true });
  ragService.indexCompanyProfile(updated._id).catch(() => {});
  res.json(updated);
});

companyRouter.post('/documents/upload', trialGuard, upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { getQueue } = require('../services/queueService');
    await getQueue('rag').add('index-document', { companyId: req.companyId, filePath: req.file.path, documentType: req.body.documentType || 'other', originalName: req.file.originalname });
    await Company.findByIdAndUpdate(req.companyId, {
      $push: { 'knowledgeBase.documents': { name: req.file.originalname, type: req.body.documentType || 'other', url: req.file.path, uploadedAt: new Date(), indexed: false } }
    });
    res.json({ success: true, file: req.file.originalname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS — WhatsApp + Email connections
// ─────────────────────────────────────────────────────────────────────────────
const settingsRouter = express.Router();
settingsRouter.use(auth, loadUser);

// Get full settings
settingsRouter.get('/', (req, res) => {
  const u = req.userDoc;
  res.json({
    preferences: u.preferences,
    whatsapp: {
      phone:     u.phone,
      verified:  u.whatsappVerified,
      connected: u.whatsappVerified,
      connectedAt: u.whatsappConnectedAt
    },
    email: {
      address:   u.email,
      notifications: u.preferences.notifyViaEmail
    },
    plan:  u.subscription?.plan,
    quota: u.quota,
    planLimits: PLANS[u.subscription?.plan || 'trial']
  });
});

// Update notification preferences
settingsRouter.put('/notifications', async (req, res) => {
  const { notifyViaWhatsApp, notifyViaEmail, alertFrequency, language, currency, timezone } = req.body;
  const upd = {};
  if (notifyViaWhatsApp !== undefined) upd['preferences.notifyViaWhatsApp'] = notifyViaWhatsApp;
  if (notifyViaEmail    !== undefined) upd['preferences.notifyViaEmail']    = notifyViaEmail;
  if (alertFrequency)  upd['preferences.alertFrequency'] = alertFrequency;
  if (language)        upd['preferences.language']       = language;
  if (currency)        upd['preferences.currency']       = currency;
  if (timezone)        upd['preferences.timezone']       = timezone;

  const updated = await User.findByIdAndUpdate(req.user.id, upd, { new: true }).select('-password');
  res.json({ success: true, preferences: updated.preferences });
});

// Update email for notifications
settingsRouter.put('/email', async (req, res) => {
  const { notificationEmail } = req.body;
  if (!notificationEmail) return res.status(400).json({ error: 'Email required' });

  // Validate email format
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(notificationEmail)) return res.status(400).json({ error: 'Invalid email format' });

  await User.findByIdAndUpdate(req.user.id, {
    email: notificationEmail.toLowerCase(),
    'preferences.notifyViaEmail': true
  });
  res.json({ success: true, message: 'Email updated. You will receive proposal drafts and alerts here.' });
});

// Update WhatsApp phone number
settingsRouter.put('/whatsapp/phone', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  // Check not taken by another user
  const existing = await User.findOne({ phone, _id: { $ne: req.user.id } });
  if (existing) return res.status(409).json({ error: 'This number is already registered' });

  await User.findByIdAndUpdate(req.user.id, {
    phone,
    whatsappVerified: false,
    whatsappConnectedAt: null,
    'preferences.notifyViaWhatsApp': false
  });
  res.json({ success: true, message: 'Phone updated. Please verify with OTP.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROPOSAL ROUTES
// ─────────────────────────────────────────────────────────────────────────────
const proposalRouter = express.Router();
proposalRouter.use(auth, loadUser, trialGuard);

proposalRouter.get('/', async (req, res) => {
  const proposals = await Proposal.find(companyFilter(req))
    .populate('tender', 'title location sector financials')
    .sort({ createdAt: -1 });
  res.json(proposals);
});

proposalRouter.get('/:id', async (req, res) => {
  const p = await Proposal.findOne({ _id: req.params.id, ...companyFilter(req) }).populate('tender');
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

proposalRouter.put('/:id', async (req, res) => {
  const { title, sections, status } = req.body;
  const keys = ['executiveSummary','technicalApproach','methodology','teamComposition','pastPerformance','financialProposal','compliance'];
  const pct  = Math.round(keys.filter(k => (sections?.[k] || '').replace(/\[PLACEHOLDER\]/g, '').trim().length > 30).length / keys.length * 100);

  const p = await Proposal.findOneAndUpdate(
    { _id: req.params.id, ...companyFilter(req) },
    { title, sections, status, completionPercentage: pct, updatedAt: new Date() },
    { new: true }
  ).populate('tender');
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

proposalRouter.post('/generate/:matchId', featureGuard('draftEnabled'), async (req, res) => {
  const match = await TenderMatch.findOne({ _id: req.params.matchId, ...companyFilter(req) }).populate('tender');
  if (!match) return res.status(404).json({ error: 'Match not found' });

  const { generateProposalAndEmail } = require('../services/proposalService');
  const proposal = await generateProposalAndEmail(match.tender, req.userDoc.company, req.userDoc, match);
  res.json(proposal);
});

proposalRouter.post('/enhance-section', featureGuard('draftEnabled'), async (req, res) => {
  const { section, currentText } = req.body;
  if (!section) return res.status(400).json({ error: 'section required' });

  try {
    const enhanced = await callAnthropic({
      system: 'Expert procurement bid writer. Enhance proposal sections. Write 3-5 professional paragraphs. Keep [PLACEHOLDER] markers. Return only the text, no preamble.',
      messages: [{ role: 'user', content: `Section: ${section}\n\nCurrent text:\n${currentText || '(empty)'}\n\nEnhance this section for a procurement proposal:` }],
      maxTokens: 1500, preferModel: 'sonnet', useCache: true
    });
    res.json({ enhanced });
  } catch (e) {
    if (e.message === 'ALL_PROVIDERS_FAILED') {
      return res.status(503).json({ error: 'ai_unavailable', message: 'AI services are busy. Please try again in a moment.' });
    }
    throw e;
  }
});

proposalRouter.post('/:id/export', async (req, res) => {
  const p = await Proposal.findOne({ _id: req.params.id, ...companyFilter(req) }).populate('tender');
  if (!p) return res.status(404).json({ error: 'Not found' });

  try {
    const doc  = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const green = rgb(0.07, 0.53, 0.25);
    const gray  = rgb(0.4, 0.4, 0.4);
    const black = rgb(0, 0, 0);

    const addPage = () => { const pg = doc.addPage([595, 842]); return { pg, y: 780 }; };
    const wrap = (pg, text, x, y, opts = {}) => {
      const { size = 11, f = font, color = black, mw = 495 } = opts;
      const words = (text || '').split(' ');
      let line = '', cy = y;
      for (const w of words) {
        const t = line ? `${line} ${w}` : w;
        if (f.widthOfTextAtSize(t, size) > mw && line) { pg.drawText(line, { x, y: cy, size, font: f, color }); cy -= size + 4; line = w; }
        else line = t;
      }
      if (line) { pg.drawText(line, { x, y: cy, size, font: f, color }); cy -= size + 4; }
      return cy;
    };

    let { pg, y } = addPage();
    pg.drawText('PROPOSAL', { x: 50, y, size: 9, font, color: green }); y -= 28;
    y = wrap(pg, p.title || 'Proposal', 50, y, { size: 20, f: bold });
    y -= 6; pg.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: green }); y -= 18;

    const secs = [['executiveSummary','Executive Summary'],['technicalApproach','Technical Approach'],['methodology','Methodology & Timeline'],['teamComposition','Team Composition'],['pastPerformance','Past Performance'],['financialProposal','Financial Proposal'],['compliance','Compliance Statement']];
    for (const [key, label] of secs) {
      const content = p.sections?.[key]; if (!content?.trim()) continue;
      if (y < 120) { ({ pg, y } = addPage()); }
      pg.drawText(label.toUpperCase(), { x: 50, y, size: 10, font: bold, color: green }); y -= 14;
      pg.drawLine({ start: { x: 50, y: y + 4 }, end: { x: 545, y: y + 4 }, thickness: 0.5, color: gray }); y -= 8;
      for (const para of content.split('\n').filter(p => p.trim())) {
        if (y < 80) { ({ pg, y } = addPage()); }
        y = wrap(pg, para.trim(), 50, y, { size: 10 }); y -= 4;
      }
      y -= 12;
    }
    doc.getPages().forEach((pg, i) => pg.drawText(`TenderPro AI — Page ${i + 1}`, { x: 50, y: 28, size: 8, font, color: gray }));

    const bytes = await doc.save();
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="proposal-${p._id}.pdf"` });
    res.send(Buffer.from(bytes));
  } catch (e) { logger.error('PDF export:', e); res.status(500).json({ error: 'PDF export failed' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ALERTS
// ─────────────────────────────────────────────────────────────────────────────
const alertRouter = express.Router();
alertRouter.use(auth, loadUser);

alertRouter.get('/', async (req, res) => {
  const matches = await TenderMatch.find({ ...companyFilter(req), alertSent: true })
    .populate('tender', 'title location sector financials dates source')
    .sort({ alertSentAt: -1 }).limit(30);
  res.json(matches);
});

alertRouter.get('/settings', (req, res) => res.json(req.userDoc.preferences));

alertRouter.put('/settings', async (req, res) => {
  const keys = ['language','currency','timezone','alertFrequency','notifyViaWhatsApp','notifyViaEmail'];
  const upd = {}; keys.forEach(k => { if (req.body[k] !== undefined) upd[`preferences.${k}`] = req.body[k]; });
  const u = await User.findByIdAndUpdate(req.user.id, upd, { new: true });
  res.json(u.preferences);
});

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────
const analyticsRouter = express.Router();
analyticsRouter.use(auth, loadUser);

analyticsRouter.get('/dashboard', async (req, res) => {
  const cid = req.companyId;
  const ago = new Date(Date.now() - 30 * 24 * 3600_000);
  const [total, monthly, sectors, avgArr, winCount] = await Promise.all([
    Tender.countDocuments({ status: 'active' }),
    TenderMatch.countDocuments({ company: cid, createdAt: { $gte: ago } }),
    TenderMatch.aggregate([
      { $match: { company: require('mongoose').Types.ObjectId.createFromHexString(cid) } },
      { $lookup: { from: 'tenders', localField: 'tender', foreignField: '_id', as: 'td' } },
      { $unwind: { path: '$td', preserveNullAndEmptyArrays: true } },
      { $group: { _id: '$td.sector', count: { $sum: 1 }, avgScore: { $avg: '$matchScore' } } },
      { $sort: { count: -1 } }, { $limit: 6 }
    ]),
    TenderMatch.aggregate([
      { $match: { company: require('mongoose').Types.ObjectId.createFromHexString(cid) } },
      { $group: { _id: null, avg: { $avg: '$matchScore' } } }
    ]),
    TenderMatch.countDocuments({ company: cid, 'winProbability.probability': { $exists: true } })
  ]);
  res.json({ totalActiveTenders: total, matchesThisMonth: monthly, topMatchingSectors: sectors, averageMatchScore: Math.round(avgArr[0]?.avg || 0), winProbabilityCount: winCount, agentStatus: 'active' });
});

analyticsRouter.get('/agent-credits', async (req, res) => {
  try {
    const { getRedisClient } = require('../utils/redis');
    const r = getRedisClient();
    const [lastDisc, portals] = await Promise.all([r.get('orchestrator:last_discovery_run').catch(() => null), r.sCard('verified_portals_list').catch(() => 0)]);
    res.json({ verifiedPortals: portals, lastDiscovery: lastDisc, creditCost: '$0 this week' });
  } catch { res.json({ verifiedPortals: 0, lastDiscovery: null, creditCost: '$0 this week' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENTS
// ─────────────────────────────────────────────────────────────────────────────
const paymentRouter = express.Router();

paymentRouter.post('/mpesa/initiate', auth, loadUser, trialGuard, async (req, res) => {
  const plans = { starter: 1300, professional: 6500, enterprise: 26000 };
  const { plan } = req.body;
  if (!plans[plan]) return res.status(400).json({ error: 'Invalid plan' });

  const phone  = (req.body.phone || req.userDoc.phone).replace(/[^0-9]/g, '');
  const result = await initiateMpesaPayment(phone, plans[plan], `TenderPro ${plan}`);
  await Payment.create({ company: req.companyId, user: req.user.id, amount: plans[plan], currency: 'KES', method: 'mpesa', status: 'pending', plan, mpesaCheckoutRequestId: result.CheckoutRequestID, periodEnd: new Date(Date.now() + 30 * 86_400_000) });
  res.json({ checkoutRequestId: result.CheckoutRequestID, message: 'STK push sent' });
});

paymentRouter.post('/mpesa/callback', async (req, res) => {
  res.sendStatus(200);
  await handleMpesaCallback(req.body).catch(() => {});
});

paymentRouter.post('/stripe/create-intent', auth, loadUser, async (req, res) => {
  res.json(await initiateStripePayment(req.user.id, req.body.plan));
});

paymentRouter.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (e) { return res.status(400).send(`Error: ${e.message}`); }
  if (event.type === 'payment_intent.succeeded') {
    const { planName, companyId } = event.data.object.metadata;
    await activateSubscription(companyId, planName).catch(() => {});
  }
  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR
// ─────────────────────────────────────────────────────────────────────────────
const calendarRouter = express.Router();
calendarRouter.use(auth, loadUser);

calendarRouter.get('/auth', featureGuard('calendarEnabled'), (req, res) => {
  const o = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  res.json({ authUrl: o.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar.events'], state: req.user.id }) });
});

calendarRouter.get('/callback', async (req, res) => {
  const { code, state: uid } = req.query;
  const o = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  const { tokens } = await o.getToken(code);
  await User.findByIdAndUpdate(uid, { googleTokens: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: new Date(tokens.expiry_date) } });
  res.redirect(`${process.env.FRONTEND_URL}/settings?calendar=connected`);
});

calendarRouter.post('/add', featureGuard('calendarEnabled'), async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ error: 'matchId required' });
  const match = await TenderMatch.findOne({ _id: matchId, ...companyFilter(req) }).populate('tender');
  if (!match?.tender) return res.status(404).json({ error: 'Not found' });
  const added = [];
  try {
    if (match.tender.dates?.preBidMeeting) { await createCalendarEvent(req.userDoc, `Pre-Bid: ${match.tender.title}`, match.tender.dates.preBidMeeting); added.push('Pre-bid meeting'); }
    if (match.tender.dates?.closingDate)   { await createCalendarEvent(req.userDoc, `⏰ DEADLINE: ${match.tender.title}`, match.tender.dates.closingDate); added.push('Deadline'); }
    res.json({ success: true, added });
  } catch { res.status(400).json({ error: 'Connect Google Calendar in Settings first.' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// INTELLIGENCE
// ─────────────────────────────────────────────────────────────────────────────
const intelligenceRouter = express.Router();
intelligenceRouter.use(auth, loadUser);

intelligenceRouter.get('/competitors', async (req, res) => {
  const { country, sector } = req.query;
  const competitors = (req.userDoc.company.competitorIntelligence || []).filter(c => {
    if (country && c.country !== country) return false;
    if (sector  && c.sector  !== sector)  return false;
    return true;
  });
  res.json({ competitors });
});

// ─────────────────────────────────────────────────────────────────────────────
// UPGRADE
// ─────────────────────────────────────────────────────────────────────────────
const upgradeRouter = express.Router();
upgradeRouter.use(auth, loadUser);

upgradeRouter.get('/plans', (req, res) => {
  const currentPlan = req.userDoc?.subscription?.plan || 'trial';
  const trialDaysLeft = req.userDoc?.subscription?.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(req.userDoc.subscription.trialEndsAt) - Date.now()) / 86_400_000))
    : 0;

  res.json({
    currentPlan, trialDaysLeft,
    plans: {
      starter:      { price: 9.99,  priceKES: 1300,  ...PLANS.starter,      features: ['20 alerts/month','10 searches/day','WhatsApp alerts','Email support'] },
      professional: { price: 49.99, priceKES: 6500,  ...PLANS.professional, features: ['100 alerts/month','50 searches/day','AI proposal drafts','Calendar sync','Win probability'] },
      enterprise:   { price: 199.99,priceKES: 26000, ...PLANS.enterprise,   features: ['Unlimited alerts','Unlimited searches','Full RAG','API access','Priority support'] }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  authRoutes:        authRouter,
  tenderRoutes:      tenderRouter,
  companyRoutes:     companyRouter,
  proposalRoutes:    proposalRouter,
  alertRoutes:       alertRouter,
  analyticsRoutes:   analyticsRouter,
  paymentRoutes:     paymentRouter,
  calendarRoutes:    calendarRouter,
  intelligenceRoutes: intelligenceRouter,
  settingsRoutes:    settingsRouter,
  upgradeRoutes:     upgradeRouter
};
