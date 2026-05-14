/**
 * WhatsApp Message Formatters (v2)
 *
 * New in v2:
 *  ✓ Win-probability score shown on every alert
 *  ✓ "Verified Source" badge with direct link to original PDF/portal
 *  ✓ Shadow-conflict warning: "⚠️ Verification Required" when models disagree
 *  ✓ Human-review flag shown on alerts for contested data
 *  ✓ Currency normalisation shown inline (e.g. KES 2.4M ≈ USD 18,500)
 */

function formatTenderAlert(tender, match, userPrefs = {}) {
  const currency          = tender.financials?.currency || 'USD';
  const value             = tender.financials?.estimatedValue;
  const normCurrency      = match.normalizedFinancials?.normalizedCurrency || userPrefs.currency || 'USD';
  const normValue         = match.normalizedFinancials?.normalizedValue;
  const daysLeft          = tender.dates?.closingDate
    ? Math.ceil((new Date(tender.dates.closingDate) - Date.now()) / 86_400_000)
    : null;

  const goEmoji = { go: '🟢', no_go: '🔴', review: '🟡' }[match.analysis?.goNoGo] || '🔵';
  const winProb = match.winProbability?.probability;

  let msg = `🔔 *NEW TENDER MATCH*\n`;
  msg    += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg    += `📋 *${tender.title}*\n\n`;

  // Location
  msg += `📍 *Location:* ${tender.location?.country || 'International'}`;
  if (tender.location?.region) msg += `, ${tender.location.region}`;
  msg += '\n';

  // Match + Win scores
  msg += `🎯 *Match:* ${scoreBar(match.matchScore)} ${match.matchScore}%\n`;
  msg += `${goEmoji} *Go/No-Go:* ${goNoGoLabel(match.analysis?.goNoGo)}\n`;
  if (winProb !== null && winProb !== undefined) {
    msg += `🏆 *Win Probability:* ${winProb}%`;
    if (match.winProbability?.recommendation) {
      msg += ` — ${recLabel(match.winProbability.recommendation)}`;
    }
    msg += '\n';
  }
  msg += `🔍 *Confidence:* ${match.confidenceScore}%\n\n`;

  // Financials with currency normalisation
  if (value) {
    msg += `💰 *Budget:* ${currency} ${value.toLocaleString()}`;
    if (normValue && normCurrency !== currency) {
      msg += ` ≈ ${normCurrency} ${Math.round(normValue).toLocaleString()}`;
    }
    msg += '\n';
  }
  if (match.winProbability?.pricingInsight) {
    msg += `💡 *Pricing tip:* _${match.winProbability.pricingInsight}_\n`;
  }

  // Deadline
  if (daysLeft !== null) {
    const urg = daysLeft <= 3 ? '🚨' : daysLeft <= 7 ? '⚠️' : '📅';
    msg += `${urg} *Deadline:* ${daysLeft > 0 ? `${daysLeft} days` : 'TODAY'} `;
    if (tender.dates?.closingDate) msg += `(${new Date(tender.dates.closingDate).toDateString()})`;
    msg += '\n';
  }
  if (tender.dates?.preBidMeeting) {
    msg += `🤝 *Pre-bid:* ${new Date(tender.dates.preBidMeeting).toDateString()}\n`;
  }

  msg += `🏷️ *Type:* ${tender.tenderType || 'Services'} | ${tender.sector || 'General'}\n\n`;

  // AI reasoning
  if (match.reasoning) msg += `🤖 *Analysis:*\n_${match.reasoning}_\n\n`;

  // Win-prob gap analysis
  const gaps = match.winProbability?.gapAnalysis?.filter(g => g.severity === 'blocker') || [];
  if (gaps.length > 0) {
    msg += `🚫 *Blockers:*\n`;
    gaps.forEach(g => { msg += `  • ${g.gap}${g.remedy ? ` → ${g.remedy}` : ''}\n`; });
    msg += '\n';
  }

  // Strengths
  if (match.analysis?.strengths?.length > 0) {
    msg += `✅ *Strengths:*\n`;
    match.analysis.strengths.slice(0, 2).forEach(s => { msg += `  • ${s}\n`; });
    msg += '\n';
  }

  // Deal breakers
  if (match.analysis?.dealBreakers?.length > 0) {
    msg += `⛔ *Deal Breakers:*\n`;
    match.analysis.dealBreakers.forEach(d => { msg += `  • ${d}\n`; });
    msg += '\n';
  }

  // Past similar bid
  const past = match.analysis?.pastSimilarBid;
  if (past?.title) {
    msg += `📚 *Similar Past Work:* "${past.title}" (${past.year}) `;
    msg += past.won ? '✅ WON\n\n' : '❌ Lost\n\n';
  }

  // Competitor intelligence
  if (match.competitorInsight?.usualWinners?.length > 0) {
    const top = match.competitorInsight.usualWinners[0];
    msg += `🕵️ *Intel:* ${top.name} often wins similar bids`;
    if (top.avgBid) msg += ` at ~${top.currency} ${top.avgBid?.toLocaleString()}`;
    msg += '\n\n';
  }

  // ── Verified Source badge ───────────────────────────────────────────────
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  if (tender.source?.name) {
    msg += `🛡️ *Verified Source:* ${tender.source.name}\n`;
  }
  msg += `🔗 *Original Link:* ${tender.source?.url}\n`;

  // Shadow-conflict / human review flag
  if (match.requiresReview || match.shadowConflicts?.length > 0) {
    msg += `\n⚠️ *VERIFICATION REQUIRED*\n`;
    msg += `_Two AI models disagreed on: ${(match.shadowConflicts || []).map(c => c.field).join(', ')}_\n`;
    msg += `_Please verify against original source before bidding._\n`;
  }

  if (tender.language && tender.language !== 'en') {
    msg += `\n🌍 _Originally in ${langName(tender.language)} — auto-translated_`;
  }

  msg += `\n\n*Actions:*\n`;
  msg += `✅ INTERESTED  |  ✍️ DRAFT  |  📅 CALENDAR  |  ❌ NOT RELEVANT`;

  return msg;
}

// ── Compact score bar ─────────────────────────────────────────────────────────
function scoreBar(score) {
  const n = Math.round((score || 0) / 10);
  return '█'.repeat(n) + '░'.repeat(10 - n);
}

function goNoGoLabel(g) {
  return { go: 'GO ✅', no_go: 'NO-GO ❌', review: 'REVIEW 🔍' }[g] || 'PENDING';
}

function recLabel(r) {
  return { bid: 'Bid', skip: 'Skip', partner: 'Partner recommended', review: 'Review first' }[r] || r;
}

function langName(code) {
  const m = { fr:'French', sw:'Swahili', ar:'Arabic', pt:'Portuguese', es:'Spanish', de:'German', am:'Amharic', zh:'Chinese' };
  return m[code] || code.toUpperCase();
}

module.exports = { formatTenderAlert, scoreBar, goNoGoLabel };
