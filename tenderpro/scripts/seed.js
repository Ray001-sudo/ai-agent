'use strict';
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

// ── Locate .env ───────────────────────────────────────────────────────────────
const envCandidates = [
  path.join(__dirname, '../backend/.env'),
  path.join(__dirname, '.env'),
  path.join(process.cwd(), 'backend/.env'),
  path.join(process.cwd(), '.env')
];
const envPath = envCandidates.find(p => fs.existsSync(p));
if (!envPath) { console.error('❌  backend/.env not found.'); process.exit(1); }
require('dotenv').config({ path: envPath });
console.log('✅ Loaded env:', envPath);

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tenderpro';
const REDIS_URL = process.env.REDIS_URL   || 'redis://localhost:6379';

async function checkMongo() {
  if (MONGO_URI.startsWith('mongodb+srv://')) { console.log('  ℹ️  Atlas URI — skipping TCP pre-flight'); return true; }
  return new Promise(resolve => {
    const net = require('net');
    let host = 'localhost', port = 27017;
    try { const u = new URL(MONGO_URI.replace('mongodb://', 'http://')); host = u.hostname || 'localhost'; port = parseInt(u.port) || 27017; } catch {}
    const s = new net.Socket();
    s.setTimeout(3000);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error',   () => { s.destroy(); resolve(false); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

async function checkRedis() {
  return new Promise(resolve => {
    const net = require('net');
    let host = 'localhost', port = 6379;
    try { const u = new URL(REDIS_URL); host = u.hostname || 'localhost'; port = parseInt(u.port) || 6379; } catch {}
    const s = new net.Socket();
    s.setTimeout(2000);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error',   () => { s.destroy(); resolve(false); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

async function seed() {
  console.log('\n🔍 Pre-flight checks…');
  const mongoOk = await checkMongo();
  if (!mongoOk) {
    console.error('\n❌  MongoDB not reachable:', MONGO_URI);
    console.error('    Fix: docker run -d -p 27017:27017 --name mongo mongo:7.0');
    console.error('    Or set MONGODB_URI=mongodb+srv://... in backend/.env');
    process.exit(1);
  }
  console.log('  ✅ MongoDB reachable');
  const redisOk = await checkRedis();
  console.log(redisOk ? '  ✅ Redis reachable' : '  ⚠️  Redis not reachable — portal seeding skipped');

  // Use mongoose from backend node_modules to avoid duplicate-instance bug
  const mongoosePath = path.join(__dirname, '../backend/node_modules/mongoose');
  if (!fs.existsSync(mongoosePath)) { console.error('❌  Run: cd backend && npm install'); process.exit(1); }
  const mongoose = require(mongoosePath);

  console.log('\n🌱 Connecting…');
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 30000, connectTimeoutMS: 30000, socketTimeoutMS: 60000 });
  await mongoose.connection.db.admin().ping();
  console.log('✅ Connected & ping OK\n');

  // Load models via same mongoose instance
  const modelsPath = path.join(__dirname, '../backend/models/index.js');
  const { User, Company, Tender, TenderMatch } = require(modelsPath);
  const names = mongoose.modelNames();
  if (!names.length) { console.error('❌  No models registered — check backend/models/index.js'); process.exit(1); }
  console.log('📦 Models:', names.join(', '), '\n');

  const bcrypt = require(path.join(__dirname, '../backend/node_modules/bcryptjs'));

  // Clear old seed data
  console.log('🗑️  Clearing old seed data…');
  await Promise.all([
    User.deleteMany({ email: 'demo@tenderpro.ai' }),
    Company.deleteMany({ name: 'TenderPro Demo Company' }),
    Tender.deleteMany({ 'source.name': /\(Seed\)$/ }),
    TenderMatch.deleteMany({})
  ]);

  // Company
  console.log('🏢 Creating demo company…');
  const ns       = 'co-' + crypto.randomBytes(8).toString('hex');
  const trialEnd = new Date(Date.now() + 3 * 24 * 3600000);
  const company  = await Company.create({
    name: 'TenderPro Demo Company',
    description: 'A technology and consulting firm specialising in cloud solutions, software development, and IT infrastructure across East Africa.',
    industry: ['Information Technology', 'Consulting & Advisory', 'Cloud Services'],
    services: ['Software Development', 'Cloud Migration', 'IT Consulting', 'Data Analytics', 'Cybersecurity'],
    yearsFounded: 2015,
    certifications: [
      { name: 'ISO 27001', issuedBy: 'BSI Group', validUntil: new Date('2026-12-31') },
      { name: 'ISO 9001',  issuedBy: 'BSI Group', validUntil: new Date('2026-06-30') }
    ],
    locations: [{ country: 'Kenya', countryCode: 'KE', region: 'Nairobi', city: 'Nairobi', isPrimary: true }],
    targetLocations: [
      { country: 'Kenya',         countryCode: 'KE', region: 'Nairobi' },
      { country: 'Uganda',        countryCode: 'UG' },
      { country: 'Tanzania',      countryCode: 'TZ' },
      { country: 'International', countryCode: 'INT' }
    ],
    tenderPreferences: { minBudget: 50000, maxBudget: 5000000, currency: 'USD', sectors: ['Information Technology', 'Cloud Services', 'Consulting & Advisory'] },
    pastBids: [
      { tenderTitle: 'IFMIS Cloud Migration', client: 'Kenya Treasury', value: 1200000, currency: 'USD', won: true,  year: 2023, sector: 'Information Technology', country: 'Kenya' },
      { tenderTitle: 'Health Data Platform',  client: 'Kenya MOH',      value: 450000,  currency: 'USD', won: true,  year: 2022, sector: 'Healthcare & Medical',  country: 'Kenya' },
      { tenderTitle: 'ERP Implementation',    client: 'Uganda RA',      value: 800000,  currency: 'USD', won: false, year: 2023, sector: 'Information Technology', country: 'Uganda' }
    ],
    competitorIntelligence: [
      { competitorName: 'TechBridge Africa',   country: 'Kenya', sector: 'Information Technology', avgWinAmount: 750000,   currency: 'USD', tendersWon: 8  },
      { competitorName: 'Digital Frontiers',   country: 'Kenya', sector: 'Information Technology', avgWinAmount: 1100000,  currency: 'USD', tendersWon: 12 },
      { competitorName: 'InfoSys East Africa', country: 'Kenya', sector: 'Consulting & Advisory',  avgWinAmount: 420000,   currency: 'USD', tendersWon: 5  }
    ],
    knowledgeBase: { vectorNamespace: ns, documentCount: 0 },
    plan: 'professional'
  });

  // User (superadmin)
  console.log('👤 Creating demo admin user…');
  const user = await User.create({
    name:     'Demo Admin',
    email:    'demo@tenderpro.ai',
    password: await bcrypt.hash('TenderPro2024!', 12),
    phone:    '+254700000000',
    company:  company._id,
    role:     'superadmin',
    whatsappVerified: false,
    preferences: { language: 'en', currency: 'USD', timezone: 'Africa/Nairobi', alertFrequency: 'instant', notifyViaWhatsApp: false, notifyViaEmail: true },
    subscription: { plan: 'professional', status: 'active', trialEndsAt: trialEnd, expiresAt: new Date(Date.now() + 30 * 24 * 3600000) },
    quota: { searchesToday: 0, alertsThisMonth: 0 }
  });

  // Tenders
  console.log('📋 Creating sample tenders…');
  const now    = new Date();
  const future = d => new Date(now.getTime() + d * 86400000);

  const tenders = await Tender.insertMany([
    { title: 'Supply and Implementation of Integrated Government Financial Management System (IFMIS)', description: 'The National Treasury invites bids for supply, implementation, and maintenance of an IFMIS platform covering budgeting, accounting, procurement, and reporting for all 47 county governments.', reference: 'NT/ICT/2025/001', source: { name: 'Kenya PPIP (Seed)', url: 'https://tenders.go.ke/demo/NT-ICT-2025-001', country: 'Kenya', type: 'government' }, status: 'active', sector: 'Information Technology', tenderType: 'services', location: { country: 'Kenya', countryCode: 'KE', region: 'Nairobi' }, financials: { estimatedValue: 2400000, currency: 'KES', usdEquivalent: 18500 }, dates: { published: now, closingDate: future(21), preBidMeeting: future(7) }, requirements: { eligibility: ['Registered company in Kenya', 'Minimum 5 years ERP experience', 'ISO 27001 certified'], certifications: ['ISO 27001', 'ISO 9001'], localContentRequirement: '30% local content required' }, language: 'en', confidenceScore: 92, agentDiscovered: true },
    { title: 'Provision of Cloud Infrastructure and DevOps Services for UNDP Regional Hub', description: 'UNDP is seeking a qualified vendor to provide cloud infrastructure management, CI/CD pipeline implementation, Kubernetes orchestration, and 24/7 DevOps support across 12 country offices.', reference: 'UNDP/KEN/2025/0042', source: { name: 'UNDP (Seed)', url: 'https://procurement-notices.undp.org/demo/112233', country: 'International', type: 'un' }, status: 'active', sector: 'Cloud Services', tenderType: 'services', location: { country: 'International', countryCode: 'INT' }, financials: { estimatedValue: 850000, currency: 'USD', usdEquivalent: 850000 }, dates: { published: now, closingDate: future(28) }, requirements: { eligibility: ['5+ years cloud infrastructure experience', 'AWS/GCP/Azure certified team'], certifications: ['ISO 27001'] }, language: 'en', confidenceScore: 95, agentDiscovered: true },
    { title: 'Consultancy for Digital Transformation Strategy — Uganda Ministry of ICT', description: 'Ministry of ICT Uganda seeks a consultancy to develop a comprehensive 5-year National Digital Transformation Strategy.', reference: 'MICT/2025/CONS/007', source: { name: 'Uganda PPDA (Seed)', url: 'https://www.ppda.go.ug/demo/MICT-2025-CONS-007', country: 'Uganda', type: 'government' }, status: 'active', sector: 'Consulting & Advisory', tenderType: 'consulting', location: { country: 'Uganda', countryCode: 'UG', region: 'Kampala' }, financials: { estimatedValue: 180000000, currency: 'UGX', usdEquivalent: 48000 }, dates: { published: now, closingDate: future(35), preBidMeeting: future(14) }, requirements: { eligibility: ['ICT consultancy firm', 'Minimum 3 national-level ICT strategy projects'], certifications: ['ISO 9001'] }, language: 'en', confidenceScore: 87, agentDiscovered: true },
    { title: 'IT Security Assessment and Penetration Testing — Kenya Revenue Authority', description: 'KRA requires a qualified cybersecurity firm to conduct comprehensive security assessment, penetration testing, and vulnerability analysis.', reference: 'KRA/IT/2025/SEC/015', source: { name: 'Kenya PPIP (Seed)', url: 'https://tenders.go.ke/demo/KRA-IT-2025-SEC-015', country: 'Kenya', type: 'government' }, status: 'active', sector: 'Cybersecurity', tenderType: 'services', location: { country: 'Kenya', countryCode: 'KE', region: 'Nairobi' }, financials: { estimatedValue: 8500000, currency: 'KES', usdEquivalent: 65000 }, dates: { published: now, closingDate: future(14) }, requirements: { eligibility: ['CREST/OSCP/CEH certified team', 'Minimum 3 government security projects'], certifications: ['ISO 27001'] }, language: 'en', confidenceScore: 91, agentDiscovered: true },
    { title: 'Provision of Software Development Services — World Bank Education Project', description: 'The World Bank invites proposals for development of a Learning Management System for 500 schools in Sub-Saharan Africa.', reference: 'WB/P178923/ICT/2025', source: { name: 'UNGM (Seed)', url: 'https://www.ungm.org/demo/212345', country: 'International', type: 'multilateral' }, status: 'active', sector: 'Software Development', tenderType: 'services', location: { country: 'International', countryCode: 'INT' }, financials: { estimatedValue: 1200000, currency: 'USD', usdEquivalent: 1200000 }, dates: { published: now, closingDate: future(30), preBidMeeting: future(10) }, requirements: { eligibility: ['EdTech experience', 'Mobile development capability'], certifications: ['ISO 9001'] }, language: 'en', confidenceScore: 89, agentDiscovered: true },
    { title: 'Data Analytics Platform — Central Bank of Nigeria', description: 'CBN requires development of an enterprise data analytics platform for regulatory reporting and financial stability monitoring.', reference: 'CBN/IT/2025/DAP/003', source: { name: 'Nigeria BPP (Seed)', url: 'https://www.bpp.gov.ng/demo/CBN-IT-2025-DAP-003', country: 'Nigeria', type: 'government' }, status: 'active', sector: 'Information Technology', tenderType: 'services', location: { country: 'Nigeria', countryCode: 'NG', region: 'Abuja' }, financials: { estimatedValue: 750000000, currency: 'NGN', usdEquivalent: 475000 }, dates: { published: now, closingDate: future(42) }, requirements: { eligibility: ['Financial services IT experience', 'Big data/analytics expertise'], certifications: ['ISO 27001'] }, language: 'en', confidenceScore: 84, agentDiscovered: true },
    { title: 'IT Support and Managed Services — USAID Kenya Mission', description: 'USAID Kenya invites proposals for comprehensive IT support, helpdesk, network management, and cybersecurity monitoring.', reference: 'USAID/KEN/2025/IT/008', source: { name: 'SAM.gov (Seed)', url: 'https://sam.gov/demo/usaid-ken-2025-it-008', country: 'United States', type: 'government' }, status: 'active', sector: 'Information Technology', tenderType: 'services', location: { country: 'Kenya', countryCode: 'KE', region: 'Nairobi' }, financials: { estimatedValue: 320000, currency: 'USD', usdEquivalent: 320000 }, dates: { published: now, closingDate: future(20), preBidMeeting: future(8) }, requirements: { eligibility: ['US-registered or Kenyan company', 'USAID experience preferred'], certifications: ['ISO 27001'] }, language: 'en', confidenceScore: 94, agentDiscovered: true },
    { title: 'ERP Implementation — Ghana Cocoa Board', description: 'COCOBOD invites bids for supply, implementation, training, and 3-year support of an ERP system.', reference: 'COCOBOD/IT/2025/ERP/002', source: { name: 'Ghana PPA (Seed)', url: 'https://ppaghana.org/demo/COCOBOD-IT-2025-ERP-002', country: 'Ghana', type: 'parastatal' }, status: 'active', sector: 'Information Technology', tenderType: 'services', location: { country: 'Ghana', countryCode: 'GH', region: 'Greater Accra' }, financials: { estimatedValue: 4500000, currency: 'GHS', usdEquivalent: 390000 }, dates: { published: now, closingDate: future(38) }, requirements: { eligibility: ['ERP implementation experience'], certifications: ['ISO 9001'] }, language: 'en', confidenceScore: 82, agentDiscovered: true }
  ]);
  console.log('  ' + tenders.length + ' tenders created');

  // TenderMatches
  console.log('🎯 Creating tender matches…');
  const defs = [
    { i:0, score:88, conf:85, go:'go',     win:72 },
    { i:1, score:95, conf:91, go:'go',     win:80 },
    { i:2, score:82, conf:78, go:'go',     win:65 },
    { i:3, score:91, conf:90, go:'go',     win:78 },
    { i:4, score:86, conf:83, go:'go',     win:70 },
    { i:5, score:79, conf:75, go:'review', win:55 },
    { i:6, score:93, conf:92, go:'go',     win:82 },
    { i:7, score:74, conf:70, go:'review', win:58 }
  ];
  for (const d of defs) {
    const t = tenders[d.i];
    try {
      await TenderMatch.create({
        tender: t._id, company: company._id,
        matchScore: d.score, confidenceScore: d.conf,
        reasoning: 'Strong alignment with company expertise and past performance. ' + (d.go === 'go' ? 'All certification requirements met.' : 'Some requirements need verification.'),
        analysis: { strengths: ['ISO 27001 matches requirement', 'Past performance in similar sector'], risks: ['Tight timeline', 'Local content verification needed'], dealBreakers: [], recommendations: d.go === 'go' ? ['Submit EOI immediately'] : ['Verify eligibility first'], goNoGo: d.go, timelineRisk: d.score >= 85 ? 'medium' : 'high', budgetAlignment: 'within_budget' },
        winProbability: { probability: d.win, pricingInsight: 'Position bid 8-12% below market average', gapAnalysis: [{ gap: 'Local content documentation required', severity: 'warning', remedy: 'Prepare NCA certificate' }], recommendation: d.go === 'go' ? 'bid' : 'review' },
        competitorInsight: { usualWinners: [{ name: 'TechBridge Africa', avgBid: 750000, currency: 'USD', wins: 8 }], pricePoint: { avg: 925000, currency: 'USD' } },
        alertSent: true, alertSentAt: new Date(Date.now() - Math.random() * 48 * 3600000)
      });
    } catch (e) { if (e.code !== 11000) console.warn('  Match skipped:', e.message); }
  }
  console.log('  ' + defs.length + ' matches created');

  // Redis portal registry
  if (redisOk) {
    console.log('\n📡 Seeding verified portal registry…');
    try {
      const redisModule = path.join(__dirname, '../backend/node_modules/redis');
      const { createClient } = require(redisModule);
      const redis = createClient({ url: REDIS_URL });
      await redis.connect();
      const portals = [
        { host: 'tenders.go.ke',                      url: 'https://tenders.go.ke',                          country: 'Kenya',         tendersFound: 47 },
        { host: 'eprocure.go.ke',                     url: 'https://eprocure.go.ke',                         country: 'Kenya',         tendersFound: 31 },
        { host: 'www.ppda.go.ug',                     url: 'https://www.ppda.go.ug',                         country: 'Uganda',        tendersFound: 28 },
        { host: 'www.ppra.go.tz',                     url: 'https://www.ppra.go.tz',                         country: 'Tanzania',      tendersFound: 22 },
        { host: 'www.bpp.gov.ng',                     url: 'https://www.bpp.gov.ng',                         country: 'Nigeria',       tendersFound: 35 },
        { host: 'ppaghana.org',                       url: 'https://ppaghana.org',                           country: 'Ghana',         tendersFound: 19 },
        { host: 'www.etenders.gov.za',                url: 'https://www.etenders.gov.za',                    country: 'South Africa',  tendersFound: 54 },
        { host: 'www.ungm.org',                       url: 'https://www.ungm.org/Public/Notice',             country: 'International', tendersFound: 89 },
        { host: 'procurement-notices.undp.org',       url: 'https://procurement-notices.undp.org',           country: 'International', tendersFound: 67 },
        { host: 'sam.gov',                            url: 'https://sam.gov/search/?index=opp',              country: 'United States', tendersFound: 124 },
        { host: 'www.contractsfinder.service.gov.uk', url: 'https://www.contractsfinder.service.gov.uk',     country: 'United Kingdom',tendersFound: 78 }
      ];
      for (const p of portals) {
        await redis.set('verified_portal:' + p.host, JSON.stringify({ ...p, lastVerified: new Date().toISOString() }));
        await redis.sAdd('verified_portals_list', p.host);
      }
      await redis.disconnect();
      console.log('  ' + portals.length + ' portals seeded ($0 search credits needed)');
    } catch (e) { console.warn('  Redis seeding failed:', e.message); }
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  🎉  Seed complete!                          ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('\n  Dashboard:  http://localhost:3000');
  console.log('  Login:      demo@tenderpro.ai');
  console.log('  Password:   TenderPro2024!');
  console.log('  Role:       superadmin\n');
  console.log('  Admin path: /api/__<ADMIN_PATH_SECRET>/ (set in .env)\n');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(err => {
  console.error('\n❌ Seed failed:', err.message);
  if (err.message?.includes('buffering timed out')) {
    console.error('   MongoDB stopped responding. Check Atlas network access or local service.');
  }
  process.exit(1);
});
