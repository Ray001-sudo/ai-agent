import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { toast } from 'react-hot-toast';
import {
  ArrowLeft, ExternalLink, AlertTriangle, CheckCircle2, XCircle,
  Clock, DollarSign, MapPin, FileText, Users, Shield, Zap,
  ThumbsUp, ThumbsDown, Download, Calendar, TrendingUp
} from 'lucide-react';

const API = axios.create({ baseURL: '/api' });
API.interceptors.request.use(c => {
  const t = localStorage.getItem('token');
  if (t) c.headers.Authorization = `Bearer ${t}`;
  return c;
});

// ── Score ring ────────────────────────────────────────────────────────────────
function ScoreRing({ score, size = 80, label, color = '#22c55e' }) {
  const r = (size / 2) - 8;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1f2937" strokeWidth="6" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="6"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 1s ease' }} />
      </svg>
      <span className="text-xl font-bold text-white -mt-12">{score}%</span>
      <span className="text-xs text-gray-500 mt-8">{label}</span>
    </div>
  );
}

// ── Gap analysis badge ────────────────────────────────────────────────────────
function GapBadge({ severity }) {
  const styles = {
    blocker: 'bg-red-500/15 text-red-400 border-red-500/30',
    warning: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    minor:   'bg-blue-500/15 text-blue-400 border-blue-500/30'
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${styles[severity] || styles.minor}`}>
      {severity}
    </span>
  );
}

export default function TenderDetail() {
  const { matchId } = useParams();
  const navigate    = useNavigate();
  const [match, setMatch]       = useState(null);
  const [tender, setTender]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [addingCal, setAddingCal] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const r = await API.get(`/tenders/matches/${matchId}`);
        setMatch(r.data);
        setTender(r.data.tender);
      } catch {
        toast.error('Could not load tender');
        navigate('/tenders');
      } finally { setLoading(false); }
    }
    load();
  }, [matchId, navigate]);

  const sendFeedback = async (action, reason = '') => {
    try {
      await API.post(`/tenders/${matchId}/feedback`, { action, reason });
      toast.success(action === 'interested' ? '✅ Marked as interested!' : '❌ Feedback recorded');
      setMatch(prev => ({ ...prev, userActions: [...(prev.userActions || []), { action }] }));
    } catch { toast.error('Feedback failed'); }
  };

  const generateDraft = async () => {
    setDrafting(true);
    try {
      const r = await API.post(`/proposals/generate/${matchId}`);
      toast.success('Draft created! Check your email.');
      navigate(`/proposals/${r.data._id}`);
    } catch (e) {
      if (e.response?.status === 403) toast.error('Upgrade required for AI drafts');
      else toast.error('Draft generation failed');
    } finally { setDrafting(false); }
  };

  const addToCalendar = async () => {
    setAddingCal(true);
    try {
      await API.post(`/calendar/add`, { matchId });
      toast.success('📅 Deadlines added to your calendar!');
    } catch { toast.error('Connect Google Calendar in Settings first'); }
    finally { setAddingCal(false); }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <div className="w-12 h-12 border-2 border-green-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-gray-400">Loading analysis...</p>
      </div>
    </div>
  );

  if (!match || !tender) return null;

  const goNoGoColor = { go: '#22c55e', review: '#eab308', no_go: '#ef4444' }[match.analysis?.goNoGo] || '#6b7280';
  const goNoGoLabel = { go: 'GO', review: 'REVIEW', no_go: 'NO-GO' }[match.analysis?.goNoGo] || '—';
  const daysLeft = tender.dates?.closingDate
    ? Math.ceil((new Date(tender.dates.closingDate) - Date.now()) / 86_400_000)
    : null;

  const lastAction = match.userActions?.slice(-1)[0]?.action;

  return (
    <div className="p-8 max-w-5xl fade-in">
      {/* Back + actions */}
      <div className="flex items-center justify-between mb-6">
        <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm">
          <ArrowLeft size={16} /> Back to matches
        </button>
        <div className="flex gap-2">
          <button onClick={() => sendFeedback('interested')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors border
              ${lastAction === 'interested' ? 'bg-green-500/20 border-green-500/40 text-green-400' : 'border-gray-700 text-gray-300 hover:bg-gray-800'}`}>
            <ThumbsUp size={14} /> Interested
          </button>
          <button onClick={() => sendFeedback('not_relevant')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors">
            <ThumbsDown size={14} /> Not Relevant
          </button>
          <button onClick={generateDraft} disabled={drafting}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-green-500 hover:bg-green-400 text-black disabled:opacity-50 transition-colors">
            <FileText size={14} /> {drafting ? 'Drafting…' : 'Draft Proposal'}
          </button>
          <button onClick={addToCalendar} disabled={addingCal}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors">
            <Calendar size={14} /> {addingCal ? '…' : 'Calendar'}
          </button>
        </div>
      </div>

      {/* Title block */}
      <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800 mb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-xs px-2.5 py-1 bg-blue-500/15 text-blue-400 rounded-full border border-blue-500/30">
                {tender.tenderType || 'services'}
              </span>
              {tender.requiresHumanReview && (
                <span className="text-xs px-2.5 py-1 bg-yellow-500/15 text-yellow-400 rounded-full border border-yellow-500/30 flex items-center gap-1">
                  <AlertTriangle size={10} /> Verify Data
                </span>
              )}
              {match.requiresReview && (
                <span className="text-xs px-2.5 py-1 bg-orange-500/15 text-orange-400 rounded-full border border-orange-500/30">
                  Shadow Conflict
                </span>
              )}
            </div>
            <h1 className="text-2xl font-bold text-white leading-snug">{tender.title}</h1>
            <div className="flex items-center gap-4 mt-3 flex-wrap">
              <span className="flex items-center gap-1.5 text-gray-400 text-sm">
                <MapPin size={14} /> {tender.location?.country}{tender.location?.region ? `, ${tender.location.region}` : ''}
              </span>
              <span className="flex items-center gap-1.5 text-gray-400 text-sm">
                <Shield size={14} /> {tender.source?.name}
              </span>
              {tender.sector && (
                <span className="flex items-center gap-1.5 text-gray-400 text-sm">
                  <Zap size={14} /> {tender.sector}
                </span>
              )}
            </div>
          </div>
          <a href={tender.source?.url} target="_blank" rel="noreferrer"
            className="flex items-center gap-1.5 text-green-400 hover:text-green-300 text-sm whitespace-nowrap border border-green-500/30 px-3 py-1.5 rounded-lg hover:bg-green-500/10 transition-colors">
            <ExternalLink size={14} /> Official Source
          </a>
        </div>
      </div>

      {/* Score cards row */}
      <div className="grid grid-cols-4 gap-4 mb-5">
        {/* Match score */}
        <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 flex flex-col items-center justify-center">
          <ScoreRing score={match.matchScore || 0} label="Match Score" color="#22c55e" />
        </div>

        {/* Go/No-Go */}
        <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 flex flex-col items-center justify-center gap-2">
          <div className="text-3xl font-black" style={{ color: goNoGoColor }}>{goNoGoLabel}</div>
          <p className="text-xs text-gray-500">Go / No-Go</p>
          <div className="text-xs text-gray-400 text-center leading-relaxed">{match.analysis?.timelineRisk ? `Timeline risk: ${match.analysis.timelineRisk}` : ''}</div>
        </div>

        {/* Win probability */}
        <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 flex flex-col items-center justify-center">
          {match.winProbability?.probability != null
            ? <ScoreRing score={match.winProbability.probability} label="Win Probability" color="#3b82f6" />
            : <div className="text-center"><p className="text-gray-500 text-sm">Win Probability</p><p className="text-gray-600 text-xs mt-1">N/A (No-Go)</p></div>}
        </div>

        {/* Confidence */}
        <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 flex flex-col items-center justify-center">
          <ScoreRing score={match.confidenceScore || 0} label="Confidence" color="#a855f7" />
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-3 gap-5">
        {/* Left col — details + requirements */}
        <div className="col-span-2 space-y-5">

          {/* AI Reasoning */}
          {match.reasoning && (
            <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <Zap size={14} className="text-green-400" /> AI Analysis
              </h3>
              <p className="text-gray-300 text-sm leading-relaxed">{match.reasoning}</p>
            </div>
          )}

          {/* Strengths / Risks / Deal Breakers */}
          {(match.analysis?.strengths?.length > 0 || match.analysis?.risks?.length > 0 || match.analysis?.dealBreakers?.length > 0) && (
            <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
              <h3 className="text-sm font-semibold text-gray-300 mb-4">Analysis Breakdown</h3>
              <div className="space-y-4">
                {match.analysis?.strengths?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-green-400 uppercase tracking-wider mb-2">Strengths</p>
                    <ul className="space-y-1.5">
                      {match.analysis.strengths.map((s, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                          <CheckCircle2 size={14} className="text-green-400 mt-0.5 flex-shrink-0" />
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {match.analysis?.risks?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-yellow-400 uppercase tracking-wider mb-2">Risks</p>
                    <ul className="space-y-1.5">
                      {match.analysis.risks.map((r, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                          <AlertTriangle size={14} className="text-yellow-400 mt-0.5 flex-shrink-0" />
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {match.analysis?.dealBreakers?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-red-400 uppercase tracking-wider mb-2">Deal Breakers</p>
                    <ul className="space-y-1.5">
                      {match.analysis.dealBreakers.map((d, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                          <XCircle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
                          {d}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {match.analysis?.recommendations?.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-blue-400 uppercase tracking-wider mb-2">Recommendations</p>
                    <ul className="space-y-1.5">
                      {match.analysis.recommendations.map((rec, i) => (
                        <li key={i} className="text-sm text-gray-300 pl-4 border-l border-blue-500/30">{rec}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Win-probability gap analysis */}
          {match.winProbability?.gapAnalysis?.length > 0 && (
            <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
              <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
                <TrendingUp size={14} className="text-blue-400" /> Win-Probability Gap Analysis
              </h3>
              {match.winProbability.pricingInsight && (
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 mb-4">
                  <p className="text-blue-300 text-sm">💡 {match.winProbability.pricingInsight}</p>
                </div>
              )}
              <div className="space-y-3">
                {match.winProbability.gapAnalysis.map((g, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <GapBadge severity={g.severity} />
                    <div>
                      <p className="text-gray-300 text-sm">{g.gap}</p>
                      {g.remedy && <p className="text-gray-500 text-xs mt-0.5">→ {g.remedy}</p>}
                    </div>
                  </div>
                ))}
              </div>
              {match.winProbability.historicalContext && (
                <p className="text-gray-500 text-xs mt-4 border-t border-gray-800 pt-3">{match.winProbability.historicalContext}</p>
              )}
            </div>
          )}

          {/* Past similar bid */}
          {match.analysis?.pastSimilarBid?.title && (
            <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <Clock size={14} className="text-purple-400" /> Similar Past Work
              </h3>
              <div className="flex items-center justify-between bg-gray-800 rounded-lg p-4">
                <div>
                  <p className="text-white text-sm font-medium">{match.analysis.pastSimilarBid.title}</p>
                  <p className="text-gray-500 text-xs mt-1">{match.analysis.pastSimilarBid.year}</p>
                </div>
                <span className={`text-sm font-bold ${match.analysis.pastSimilarBid.won ? 'text-green-400' : 'text-red-400'}`}>
                  {match.analysis.pastSimilarBid.won ? '✅ WON' : '❌ Lost'}
                </span>
              </div>
            </div>
          )}

          {/* Shadow conflict warning */}
          {match.shadowConflicts?.length > 0 && (
            <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-orange-400 mb-2 flex items-center gap-2">
                <AlertTriangle size={14} /> Verification Required
              </h3>
              <p className="text-orange-300/80 text-sm mb-3">Two AI models disagreed on the following fields. Please verify against the original source before bidding.</p>
              <div className="space-y-2">
                {match.shadowConflicts.map((c, i) => (
                  <div key={i} className="text-xs bg-orange-500/10 rounded p-2">
                    <span className="text-orange-400 font-medium">{c.field}: </span>
                    <span className="text-gray-300">Model A: {JSON.stringify(c.primaryValue)}</span>
                    <span className="text-gray-500 mx-2">vs</span>
                    <span className="text-gray-300">Model B: {JSON.stringify(c.shadowValue)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Full description */}
          {tender.description && (
            <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">Tender Description</h3>
              <p className="text-gray-400 text-sm leading-relaxed whitespace-pre-wrap">{tender.description}</p>
              {tender.language && tender.language !== 'en' && (
                <p className="text-gray-600 text-xs mt-3">🌍 Auto-translated from {tender.language.toUpperCase()}</p>
              )}
            </div>
          )}
        </div>

        {/* Right col — meta + competitor */}
        <div className="space-y-5">

          {/* Key dates */}
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
            <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
              <Clock size={14} /> Key Dates
            </h3>
            <div className="space-y-3">
              {tender.dates?.published && (
                <div>
                  <p className="text-xs text-gray-500">Published</p>
                  <p className="text-gray-300 text-sm">{new Date(tender.dates.published).toDateString()}</p>
                </div>
              )}
              {tender.dates?.preBidMeeting && (
                <div>
                  <p className="text-xs text-yellow-500">Pre-Bid Meeting</p>
                  <p className="text-yellow-300 text-sm">{new Date(tender.dates.preBidMeeting).toDateString()}</p>
                </div>
              )}
              {tender.dates?.closingDate && (
                <div>
                  <p className="text-xs text-red-400">Submission Deadline</p>
                  <p className={`text-sm font-semibold ${daysLeft <= 7 ? 'text-red-400' : daysLeft <= 14 ? 'text-yellow-400' : 'text-green-400'}`}>
                    {new Date(tender.dates.closingDate).toDateString()}
                    {daysLeft !== null && (
                      <span className="ml-2 text-xs font-normal text-gray-500">
                        {daysLeft > 0 ? `(${daysLeft} days left)` : 'EXPIRED'}
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Financials */}
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
            <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
              <DollarSign size={14} /> Budget
            </h3>
            <div className="space-y-2">
              {tender.financials?.estimatedValue ? (
                <>
                  <p className="text-2xl font-bold text-green-400">
                    {tender.financials.currency} {tender.financials.estimatedValue.toLocaleString()}
                  </p>
                  {match.normalizedFinancials?.normalizedValue && match.normalizedFinancials.normalizedCurrency !== tender.financials.currency && (
                    <p className="text-gray-500 text-sm">
                      ≈ {match.normalizedFinancials.normalizedCurrency} {Math.round(match.normalizedFinancials.normalizedValue).toLocaleString()}
                    </p>
                  )}
                  {match.analysis?.budgetAlignment && (
                    <span className={`text-xs px-2 py-0.5 rounded-full ${match.analysis.budgetAlignment === 'within_budget' ? 'bg-green-500/15 text-green-400' : match.analysis.budgetAlignment === 'over_budget' ? 'bg-red-500/15 text-red-400' : 'bg-gray-700 text-gray-400'}`}>
                      {match.analysis.budgetAlignment?.replace(/_/g, ' ')}
                    </span>
                  )}
                </>
              ) : (
                <p className="text-gray-500 text-sm">Not disclosed</p>
              )}
            </div>
          </div>

          {/* Requirements */}
          {tender.requirements?.eligibility?.length > 0 && (
            <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <Users size={14} /> Requirements
              </h3>
              <ul className="space-y-1.5">
                {tender.requirements.eligibility.slice(0, 6).map((req, i) => (
                  <li key={i} className="text-gray-400 text-xs flex items-start gap-1.5">
                    <span className="text-gray-600 mt-0.5">•</span>{req}
                  </li>
                ))}
              </ul>
              {tender.requirements?.localContentRequirement && (
                <div className="mt-3 pt-3 border-t border-gray-800">
                  <p className="text-xs text-yellow-500 font-medium">Local Content</p>
                  <p className="text-gray-400 text-xs mt-1">{tender.requirements.localContentRequirement}</p>
                </div>
              )}
            </div>
          )}

          {/* Competitor intelligence */}
          {match.competitorInsight?.usualWinners?.length > 0 && (
            <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
              <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
                <TrendingUp size={14} className="text-purple-400" /> Competitor Intel
              </h3>
              <div className="space-y-3">
                {match.competitorInsight.usualWinners.map((c, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div>
                      <p className="text-gray-300 text-sm font-medium">{c.name}</p>
                      <p className="text-gray-500 text-xs">{c.wins} wins</p>
                    </div>
                    <p className="text-green-400 text-sm font-semibold">
                      {c.currency} {c.avgBid?.toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
              {match.competitorInsight.pricePoint?.avg && (
                <div className="mt-3 pt-3 border-t border-gray-800">
                  <p className="text-xs text-gray-500">Market avg bid</p>
                  <p className="text-gray-300 text-sm font-semibold">
                    {match.competitorInsight.pricePoint.currency} {Math.round(match.competitorInsight.pricePoint.avg).toLocaleString()}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Source verification */}
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <Shield size={14} className="text-green-400" /> Verified Source
            </h3>
            <p className="text-gray-400 text-sm mb-2">{tender.source?.name}</p>
            <a href={tender.source?.url} target="_blank" rel="noreferrer"
              className="flex items-center gap-1.5 text-green-400 text-xs hover:underline break-all">
              <ExternalLink size={11} /> {tender.source?.url?.substring(0, 50)}…
            </a>
            <div className="mt-3 pt-3 border-t border-gray-800 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-400 pulse-dot" />
              <span className="text-xs text-gray-500">Agent-discovered · {tender.scrapedAt ? new Date(tender.scrapedAt).toLocaleDateString() : '—'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
