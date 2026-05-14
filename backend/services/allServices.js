/* ── Translation ───────────────────────────────────────────────────── */
const axios = require('axios');
const { logger } = require('../utils/logger');

async function translateText(text, targetLang = 'en') {
  if (!text || text.length < 3) return text;
  try {
    if (process.env.DEEPL_API_KEY) {
      const r = await axios.post('https://api-free.deepl.com/v2/translate', null, { params: { auth_key: process.env.DEEPL_API_KEY, text, target_lang: targetLang.toUpperCase() } });
      return r.data.translations[0].text;
    }
    if (process.env.GOOGLE_TRANSLATE_API_KEY) {
      const r = await axios.post(`https://translation.googleapis.com/language/translate/v2?key=${process.env.GOOGLE_TRANSLATE_API_KEY}`, { q: text, target: targetLang, format: 'text' });
      return r.data.data.translations[0].translatedText;
    }
    return text;
  } catch (e) { logger.warn(`Translation failed: ${e.message}`); return text; }
}

/* ── Currency ──────────────────────────────────────────────────────── */
let rateCache = {}, cacheTime = 0;
async function getExchangeRate(from, to) {
  if (from === to) return 1;
  const key = `${from}_${to}`;
  if (Date.now() - cacheTime < 3_600_000 && rateCache[key]) return rateCache[key];
  try {
    const r = await axios.get(`https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_RATE_API_KEY}/pair/${from}/${to}`);
    rateCache[key] = r.data.conversion_rate; cacheTime = Date.now();
    return rateCache[key];
  } catch { const fb = { USD_KES:130, USD_NGN:1580, USD_ZAR:19, USD_GBP:0.79, USD_EUR:0.93 }; return fb[key] || 1; }
}

/* ── Email ─────────────────────────────────────────────────────────── */
const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT)||587, secure:false, auth:{ user:process.env.SMTP_USER, pass:process.env.SMTP_PASS } });
async function sendEmail(to, subject, html) { await transporter.sendMail({ from: process.env.EMAIL_FROM, to, subject, html }); logger.info(`Email sent to ${to}: ${subject}`); }
async function sendProposalDraft(to, title, draft, proposalId) {
  await sendEmail(to, `📄 Draft Ready: ${title}`, `<h2>${title}</h2><p><a href="${process.env.FRONTEND_URL}/proposals/${proposalId}">Open in dashboard →</a></p><hr/><pre style="white-space:pre-wrap;font-family:Georgia">${draft.substring(0,8000)}</pre>`);
}
async function sendTenderDigest(to, name, matches) {
  const html = matches.map(m => `<div style="border:1px solid #eee;padding:12px;margin:8px 0"><h3>${m.tender?.title}</h3><p>Match: ${m.matchScore}% | Win: ${m.winProbability?.probability||'?'}% | ${m.tender?.location?.country}</p><a href="${m.tender?.source?.url}">View →</a></div>`).join('');
  await sendEmail(to, `📋 Daily Digest — ${matches.length} tender matches`, `<h2>Hi ${name},</h2>${html}<p><a href="${process.env.FRONTEND_URL}/dashboard">Dashboard →</a></p>`);
}

/* ── Calendar ──────────────────────────────────────────────────────── */
const { google } = require('googleapis');
async function createCalendarEvent(user, title, date, type) {
  if (!user.googleTokens?.accessToken) throw new Error('Google Calendar not connected');
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  auth.setCredentials(user.googleTokens);
  const cal = google.calendar({ version:'v3', auth });
  const end = new Date(date); end.setHours(end.getHours()+1);
  const ev = await cal.events.insert({ calendarId:'primary', resource:{ summary:title, start:{dateTime:new Date(date).toISOString()}, end:{dateTime:end.toISOString()}, reminders:{useDefault:false, overrides:[{method:'email',minutes:1440},{method:'popup',minutes:60}]} } });
  return ev.data.id;
}

/* ── Speech ────────────────────────────────────────────────────────── */
const OpenAI = require('openai').default;
const fs = require('fs');
const path = require('path');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function transcribeAudio(audioUrl) {
  try {
    const res = await axios.get(audioUrl, { responseType:'arraybuffer', headers:{ Authorization:`Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}` } });
    const tmp = path.join('/tmp', `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tmp, Buffer.from(res.data));
    const t = await openai.audio.transcriptions.create({ file:fs.createReadStream(tmp), model:'whisper-1' });
    fs.unlinkSync(tmp);
    return t.text;
  } catch (e) { logger.error('Transcription failed:', e.message); return null; }
}

module.exports = { translateText, getExchangeRate, sendEmail, sendProposalDraft, sendTenderDigest, createCalendarEvent, transcribeAudio };
