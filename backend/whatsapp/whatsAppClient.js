const twilio    = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { logger } = require('../utils/logger');
const { User, Company, WhatsAppSession, TenderMatch, Tender, Proposal } = require('../models');
const { AIMatchingEngine } = require('../agents/aiMatchingEngine');
const { formatTenderAlert } = require('./messageFormatter');
const { createCalendarEvent } = require('../services/calendarService');
const { initiateMpesaPayment, initiateStripePayment } = require('../services/paymentService');
const { generateProposalAndEmail } = require('../services/proposalService');
const { transcribeAudio } = require('../services/speechService');

const twilioClient   = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic      = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const matchingEngine = new AIMatchingEngine();

async function initializeWhatsApp(io) {
  logger.info('WhatsApp (Twilio) client ready');
}

async function sendWhatsAppMessage(to, message, mediaUrl = null) {
  try {
    const toNum = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const params = { from: process.env.TWILIO_WHATSAPP_NUMBER, to: toNum, body: message };
    if (mediaUrl) params.mediaUrl = [mediaUrl];
    const result = await twilioClient.messages.create(params);
    logger.info(`WhatsApp sent to ${to}: ${result.sid}`);
    return result;
  } catch (err) {
    logger.error(`WhatsApp send failed to ${to}: ${err.message}`);
    throw err;
  }
}

async function sendTenderAlert(userId, match) {
  const user = await User.findById(userId).populate('company');
  if (!user?.preferences?.notifyViaWhatsApp) return;
  const tender = await Tender.findById(match.tender);
  if (!tender) return;
  const msg = formatTenderAlert(tender, match, user.preferences);
  await sendWhatsAppMessage(user.phone, msg);
  await TenderMatch.findByIdAndUpdate(match._id, { alertSent: true, alertSentAt: new Date() });
}

async function broadcastTenderAlert(matchId) {
  const match = await TenderMatch.findById(matchId);
  if (!match) return;
  const users = await User.find({ company: match.company, 'preferences.notifyViaWhatsApp': true });
  for (const u of users) {
    try { await sendTenderAlert(u._id, match); } catch (e) { logger.warn(`Alert failed ${u.phone}: ${e.message}`); }
  }
}

async function handleIncomingMessage(from, body, mediaUrl = null, isVoice = false) {
  try {
    let session = await WhatsAppSession.findOne({ phone: from });
    if (!session) { session = new WhatsAppSession({ phone: from, state: 'new' }); await session.save(); }

    const user = await User.findOne({ phone: from }).populate('company');
    let text = (body || '').trim();

    // Voice transcription
    if (isVoice && mediaUrl) {
      const transcript = await transcribeAudio(mediaUrl);
      if (transcript) {
        text = transcript;
        await sendWhatsAppMessage(from, `🎙️ Heard: "${transcript}"\n\nProcessing...`);
      }
    }

    const lower = text.toLowerCase();

    // Onboarding for new users
    if (!user || session.state === 'new' || session.state?.startsWith('awaiting_')) {
      return await handleOnboarding(from, text, session);
    }

    if (lower === 'help' || lower === 'menu' || lower === '?') return sendHelpMenu(from);
    if (lower.startsWith('search') || lower.startsWith('find') || lower.startsWith('get me') || isVoice) return handleSearch(from, text, user, session);
    if (lower.startsWith('draft')) return handleDraft(from, user, session);
    if (lower === 'interested' || lower === '✅') return handleInterested(from, user, session);
    if (lower.startsWith('not relevant') || lower.startsWith('❌')) return handleNotRelevant(from, text, user, session);
    if (lower === 'status' || lower === 'my tenders') return handleStatus(from, user);
    if (lower.startsWith('calendar')) return handleCalendar(from, user, session);
    if (lower.startsWith('upgrade') || lower.startsWith('subscribe')) return handleUpgrade(from, text, user);
    if (lower.startsWith('mpesa') || lower.startsWith('pay')) return handleMpesaPayment(from, text, user);
    if (lower.startsWith('won') || lower === '🏆') return handleOutcome(from, 'won', user, session);
    if (lower.startsWith('lost')) return handleOutcome(from, 'lost', user, session);
    if (lower.startsWith('competitor') || lower.startsWith('who wins')) return handleCompetitor(from, user, session);
    if (lower.startsWith('settings')) return handleSettings(from);
    if (/^\d$/.test(lower)) return handleNumberSelection(from, parseInt(lower), user, session);

    return handleChat(from, text, user, session);
  } catch (err) {
    logger.error('Message handler error:', err);
    await sendWhatsAppMessage(from, '⚠️ Error processing your message. Type HELP for options.');
  }
}

async function handleOnboarding(from, body, session) {
  const state = session.state || 'new';
  if (state === 'new') {
    session.state = 'awaiting_name'; session.context = {}; await session.save();
    return sendWhatsAppMessage(from, `🌍 *Welcome to TenderPro AI!*\n\nI'm your autonomous global tender-finding agent. I browse government portals, NGOs, and international orgs worldwide every 6 hours to find tenders that match your business.\n\n*What is your full name?*`);
  }
  if (state === 'awaiting_name') { session.context.name = body; session.state = 'awaiting_company'; await session.save(); return sendWhatsAppMessage(from, `Hi ${body}! 👋\n\n*What is your company name?*`); }
  if (state === 'awaiting_company') { session.context.company = body; session.state = 'awaiting_email'; await session.save(); return sendWhatsAppMessage(from, `*What is your work email?* _(for proposal drafts)_`); }
  if (state === 'awaiting_email') { session.context.email = body; session.state = 'awaiting_sectors'; await session.save(); return sendWhatsAppMessage(from, `*What sectors does your company work in?*\n\nExamples: IT & Software, Construction, Healthcare, Consulting\n\n_Separate with commas._`); }
  if (state === 'awaiting_sectors') { session.context.sectors = body.split(',').map(s => s.trim()); session.state = 'awaiting_countries'; await session.save(); return sendWhatsAppMessage(from, `*Which countries should I monitor?*\n\nExamples: Kenya, Uganda, International (UN/World Bank)\n\n_Separate with commas._`); }
  if (state === 'awaiting_countries') {
    const { name, company: cName, email, sectors } = session.context;
    const countries = body.split(',').map(s => s.trim());
    const bcrypt = require('bcryptjs');
    const company = await Company.create({ name: cName, industry: sectors, services: sectors, knowledgeBase: { vectorNamespace: `company-${Date.now()}` }, tenderPreferences: { sectors }, targetLocations: countries.map(c => ({ country: c })) });
    const user = await User.create({ name, email, phone: from, password: await bcrypt.hash(Math.random().toString(36).slice(-8), 10), company: company._id, whatsappVerified: true, subscription: { plan: 'free', status: 'trial', alertLimitPerMonth: 5 } });
    session.user = user._id; session.company = company._id; session.state = 'active'; await session.save();
    return sendWhatsAppMessage(from, `🎉 *You're all set, ${name}!*\n\n✅ Company: *${cName}*\n🔍 Monitoring: ${countries.join(', ')}\n💼 Sectors: ${sectors.join(', ')}\n\n*I start scanning in 15 minutes!*\n\n*Commands:*\n• SEARCH [keywords]\n• STATUS — recent matches\n• SETTINGS — update prefs\n• HELP — all commands\n\n_First alerts coming shortly_ 🚀`);
  }
}

async function handleSearch(from, body, user, session) {
  const query = body.replace(/^(search|find|look for|get me)\s*/i, '').trim() || 'tenders';
  await sendWhatsAppMessage(from, `🔍 Searching for: *"${query}"*\n\nScanning verified portals... 30-60s`);
  try {
    const { AgentOrchestrator } = require('../../agent/orchestrator');
    const orch = new AgentOrchestrator(null);
    const results = await orch.scoutOnDemand(user.company._id.toString(), query);
    if (!results.length) return sendWhatsAppMessage(from, `📭 No matches found for *"${query}"* right now.\n\nI'll alert you when new ones appear. Try SEARCH [different terms] or update preferences with SETTINGS.`);
    session.context.lastSearchResults = results.map(r => r.match?._id?.toString()).filter(Boolean);
    await session.save();
    let msg = `📋 *Found ${results.length} match${results.length > 1 ? 'es' : ''} for "${query}":*\n\n`;
    results.slice(0, 5).forEach((r, i) => {
      const t = r.tender; const m = r.match;
      const days = t.dates?.closingDate ? Math.ceil((new Date(t.dates.closingDate) - Date.now()) / 86400000) : null;
      msg += `*${i+1}. ${t.title?.substring(0, 60)}*\n`;
      msg += `📍 ${t.location?.country || 'Int'} | 🎯 ${m.matchScore}% | 🏆 Win: ${m.winProbability?.probability || '?'}%\n`;
      if (t.financials?.estimatedValue) msg += `💰 ${t.financials.currency} ${t.financials.estimatedValue.toLocaleString()}\n`;
      if (days !== null) msg += `⏰ ${days > 0 ? `${days}d left` : 'EXPIRED'}\n`;
      msg += `🔗 ${t.source?.url}\n\n`;
    });
    msg += `_Reply 1-${Math.min(results.length,5)} for full analysis | DRAFT [n] for proposal_`;
    return sendWhatsAppMessage(from, msg);
  } catch (e) {
    logger.error('Search error:', e.message);
    return sendWhatsAppMessage(from, `⚠️ Search temporarily unavailable. Try again in a moment.`);
  }
}

async function handleDraft(from, user, session) {
  if (user.subscription.plan === 'free') return sendWhatsAppMessage(from, `🔒 *Proposal Drafting — Premium Feature*\n\nUpgrade to access AI drafts, full analysis & calendar sync.\n\n💳 Reply *UPGRADE* to see plans\n📱 M-Pesa & Card accepted`);
  const matchId = session.context?.lastAlertedMatch || session.context?.lastSearchResults?.[0];
  if (!matchId) return sendWhatsAppMessage(from, `📝 Please select a tender first (search or wait for an alert).`);
  await sendWhatsAppMessage(from, `✍️ *Generating draft proposal...*\n_Pulling from your knowledge base — ~30 seconds_`);
  try {
    const match = await TenderMatch.findById(matchId).populate('tender');
    if (!match?.tender) return sendWhatsAppMessage(from, `❌ Tender not found.`);
    const proposal = await generateProposalAndEmail(match.tender, user.company, user, match);
    return sendWhatsAppMessage(from, `✅ *60% Draft Ready!*\n\n📧 Emailed to: ${user.email}\n\nEdit & complete at:\n🔗 ${process.env.FRONTEND_URL}/proposals/${proposal._id}`);
  } catch (e) { return sendWhatsAppMessage(from, `⚠️ Draft generation failed. Try again shortly.`); }
}

async function handleInterested(from, user, session) {
  const matchId = session.context?.lastAlertedMatch;
  if (matchId) {
    await TenderMatch.findByIdAndUpdate(matchId, { $push: { userActions: { userId: user._id, action: 'interested', timestamp: new Date() } } });
    await Company.findByIdAndUpdate(user.company._id, { $push: { feedback: { tenderId: matchId, action: 'interested' } } });
  }
  return sendWhatsAppMessage(from, `✅ *Noted! Finding more like this.*\n\n*Next steps:*\n• ✍️ DRAFT — generate proposal\n• 📅 CALENDAR — add deadlines\n• 🕵️ COMPETITOR — market intel\n\n_I'm learning your preferences_ 🧠`);
}

async function handleNotRelevant(from, body, user, session) {
  const reason = body.replace(/^(not relevant|❌)\s*/i, '').trim();
  const matchId = session.context?.lastAlertedMatch;
  if (matchId) {
    await TenderMatch.findByIdAndUpdate(matchId, { $push: { userActions: { userId: user._id, action: 'not_relevant', reason, timestamp: new Date() } } });
    await Company.findByIdAndUpdate(user.company._id, { $push: { feedback: { tenderId: matchId, action: 'not_relevant', reason } } });
  }
  return sendWhatsAppMessage(from, `❌ *Got it! Refining your matches.*\n\n${reason ? `_Reason: "${reason}"_\n\n` : ''}I'll filter similar tenders more aggressively. Use SETTINGS to update preferences anytime. 🎯`);
}

async function handleStatus(from, user) {
  const matches = await TenderMatch.find({ company: user.company._id, alertSent: true }).populate('tender').sort({ createdAt: -1 }).limit(5);
  if (!matches.length) return sendWhatsAppMessage(from, `📭 No recent matches yet. Agent is actively scanning.\n\nTry *SEARCH [sector]* for instant results.`);
  let msg = `📊 *Recent Matches (${user.company.name}):*\n\n`;
  matches.forEach(m => {
    const emoji = { interested:'✅', applied:'📤', won:'🏆', lost:'😔', not_relevant:'❌' }[m.userActions?.slice(-1)[0]?.action] || '🔔';
    msg += `${emoji} *${m.tender?.title?.substring(0,50)}*\n🎯 ${m.matchScore}% | 🏆 ${m.winProbability?.probability || '?'}% win\n\n`;
  });
  const stats = await TenderMatch.aggregate([{ $match: { company: user.company._id } }, { $group: { _id: null, total: { $sum: 1 }, avg: { $avg: '$matchScore' } } }]);
  if (stats[0]) msg += `📈 Total: ${stats[0].total} | Avg score: ${Math.round(stats[0].avg)}%`;
  return sendWhatsAppMessage(from, msg);
}

async function handleCalendar(from, user, session) {
  const matchId = session.context?.lastAlertedMatch;
  if (!matchId) return sendWhatsAppMessage(from, `📅 Select a tender first, then reply CALENDAR.`);
  const match = await TenderMatch.findById(matchId).populate('tender');
  if (!match?.tender) return sendWhatsAppMessage(from, `❌ Tender not found.`);
  try {
    const events = [];
    if (match.tender.dates?.preBidMeeting) { await createCalendarEvent(user, `Pre-Bid: ${match.tender.title}`, match.tender.dates.preBidMeeting, 'pre-bid'); events.push('Pre-bid meeting'); }
    if (match.tender.dates?.closingDate) { await createCalendarEvent(user, `⏰ DEADLINE: ${match.tender.title}`, match.tender.dates.closingDate, 'deadline'); events.push('Submission deadline'); }
    return sendWhatsAppMessage(from, `📅 *Calendar events added!*\n\n✅ ${events.join('\n✅ ')}\n\n_Check Google/Outlook calendar_ 📆`);
  } catch { return sendWhatsAppMessage(from, `📅 Connect your calendar first:\n🔗 ${process.env.FRONTEND_URL}/settings/calendar`); }
}

async function handleUpgrade(from, body, user) {
  return sendWhatsAppMessage(from, `💳 *TenderPro Plans:*\n\n🆓 *FREE* — 5 alerts/month\n\n⭐ *STARTER* — $9.99/mo\n  • 20 alerts, basic matching\n\n💼 *PROFESSIONAL* — $49.99/mo\n  • 100 alerts, AI drafts, calendar, win-probability\n\n🏢 *ENTERPRISE* — $199.99/mo\n  • Unlimited, full RAG, API access\n\n*Pay with:*\n📱 Reply *MPESA professional*\n💳 Reply *CARD professional*`);
}

async function handleMpesaPayment(from, body, user) {
  const planMap = { starter: { kes: 1300, usd: 9.99 }, professional: { kes: 6500, usd: 49.99 }, enterprise: { kes: 26000, usd: 199.99 } };
  const words   = body.toLowerCase().split(' ');
  const planName = words.find(w => planMap[w]);
  if (!planName) return sendWhatsAppMessage(from, `Which plan? Reply: *MPESA starter* | *MPESA professional* | *MPESA enterprise*`);
  try {
    const phone = user.phone.replace(/[^0-9]/g, '');
    const result = await initiateMpesaPayment(phone, planMap[planName].kes, `TenderPro ${planName}`);
    return sendWhatsAppMessage(from, `📱 *M-Pesa STK Push Sent!*\n\nAmount: KES ${planMap[planName].kes.toLocaleString()}\n\nEnter your M-Pesa PIN on your phone.\n\n_Ref: ${result.CheckoutRequestID}_`);
  } catch (e) { return sendWhatsAppMessage(from, `⚠️ M-Pesa payment failed. Try again or use CARD ${body.split(' ').pop()}`); }
}

async function handleOutcome(from, outcome, user, session) {
  const matchId = session.context?.lastAlertedMatch;
  if (matchId) {
    await TenderMatch.findByIdAndUpdate(matchId, { $push: { userActions: { userId: user._id, action: outcome, timestamp: new Date() } } });
    if (outcome === 'won') {
      const match = await TenderMatch.findById(matchId).populate('tender');
      if (match?.tender) await Company.findByIdAndUpdate(user.company._id, { $push: { pastBids: { tenderTitle: match.tender.title, won: true, year: new Date().getFullYear(), sector: match.tender.sector, country: match.tender.location?.country } } });
    }
  }
  return sendWhatsAppMessage(from, outcome === 'won' ? `🏆 *Congratulations!* 🎉\n\nAdded to your success record. I'll find even better matches next time! 💪` : `📚 *Thanks for the update.*\n\nAnalysing what went wrong to improve future recommendations. 💪`);
}

async function handleCompetitor(from, user, session) {
  const matchId = session.context?.lastAlertedMatch;
  let country = user.company?.targetLocations?.[0]?.country || 'your region';
  let sector  = user.company?.industry?.[0] || 'your sector';
  if (matchId) {
    const m = await TenderMatch.findById(matchId).populate('tender');
    if (m?.tender) { country = m.tender.location?.country || country; sector = m.tender.sector || sector; }
  }
  const comps = (user.company?.competitorIntelligence || []).filter(c => c.country === country && c.sector === sector);
  if (!comps.length) return sendWhatsAppMessage(from, `🕵️ *Building Intel for ${sector} in ${country}...*\n\nCheck back in 24h or upgrade to Enterprise for pre-loaded data.`);
  let msg = `🕵️ *Competitor Intel: ${sector} in ${country}*\n\n`;
  comps.slice(0, 3).forEach(c => { msg += `*${c.competitorName}*\n🏆 ${c.tendersWon} wins | Avg: ${c.currency} ${c.avgWinAmount?.toLocaleString()}\n\n`; });
  return sendWhatsAppMessage(from, msg + `_Updated daily from procurement records_`);
}

async function handleSettings(from) {
  return sendWhatsAppMessage(from, `⚙️ *Update Settings:*\n\n🔗 ${process.env.FRONTEND_URL}/settings\n\n_Or reply:_\n• SETTINGS COUNTRY [name]\n• SETTINGS SECTOR [name]\n• SETTINGS BUDGET MIN [amount]\n• SETTINGS ALERTS instant|daily|weekly`);
}

async function handleNumberSelection(from, num, user, session) {
  const results = session.context?.lastSearchResults || [];
  const matchId = results[num - 1];
  if (!matchId) return sendWhatsAppMessage(from, `❓ Invalid selection. Type STATUS to see your matches.`);
  session.context.lastAlertedMatch = matchId;
  await session.save();
  const match = await TenderMatch.findById(matchId).populate('tender');
  if (!match?.tender) return sendWhatsAppMessage(from, `❌ Match not found.`);
  const msg = formatTenderAlert(match.tender, match, user.preferences);
  return sendWhatsAppMessage(from, msg);
}

async function handleChat(from, body, user, session) {
  const history = (session.context?.chatHistory || []).slice(-8);
  history.push({ role: 'user', content: body });
  const system = `You are TenderPro AI for ${user.company?.name}. Expert procurement assistant. Sectors: ${(user.company?.industry||[]).join(', ')}. Keep replies under 250 chars for WhatsApp. Guide users with commands: SEARCH, DRAFT, STATUS, SETTINGS, CALENDAR, COMPETITOR, UPGRADE, HELP.`;
  try {
    const resp = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, system, messages: history });
    const reply = resp.content[0].text;
    history.push({ role: 'assistant', content: reply });
    session.context.chatHistory = history.slice(-16);
    session.lastActivity = new Date();
    await session.save();
    return sendWhatsAppMessage(from, reply);
  } catch (e) { return sendWhatsAppMessage(from, `I can help you find tenders! Try: SEARCH IT tenders Kenya\nOr type HELP for all commands.`); }
}

async function sendHelpMenu(from) {
  return sendWhatsAppMessage(from, `🤖 *TenderPro Commands:*\n\n🔍 SEARCH [keywords] — find tenders\n📊 STATUS — your matches\n✅ INTERESTED — mark as relevant\n❌ NOT RELEVANT [reason]\n✍️ DRAFT — generate proposal\n📅 CALENDAR — add deadlines\n🕵️ COMPETITOR — market intel\n💳 UPGRADE — see plans\n⚙️ SETTINGS — update prefs\n🎙️ Voice notes — speak your search\n\n_I learn from your feedback!_ 🧠`);
}

module.exports = { sendWhatsAppMessage, sendTenderAlert, broadcastTenderAlert, handleIncomingMessage, initializeWhatsApp };
