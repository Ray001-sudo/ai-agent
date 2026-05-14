import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { toast } from 'react-hot-toast';
import { ArrowLeft, Save, Download, Send, RefreshCw, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';

const API = axios.create({ baseURL: '/api' });
API.interceptors.request.use(c => {
  const t = localStorage.getItem('token');
  if (t) c.headers.Authorization = `Bearer ${t}`;
  return c;
});

const SECTIONS = [
  { key: 'executiveSummary',    label: 'Executive Summary',         hint: 'Concise overview of your proposal, company strengths, and why you are the best fit.' },
  { key: 'technicalApproach',   label: 'Technical Approach',        hint: 'Detailed methodology, tools, and processes you will use to deliver the work.' },
  { key: 'methodology',         label: 'Methodology & Timeline',    hint: 'Step-by-step implementation plan with milestones and deadlines.' },
  { key: 'teamComposition',     label: 'Team Composition',          hint: 'Key personnel, their roles, qualifications, and relevant experience.' },
  { key: 'pastPerformance',     label: 'Past Performance',          hint: 'Reference projects demonstrating your capability and track record.' },
  { key: 'financialProposal',   label: 'Financial Proposal',        hint: 'Cost breakdown, pricing rationale, and payment terms.' },
  { key: 'compliance',          label: 'Compliance Statement',      hint: 'Confirmation that all eligibility requirements and certifications are met.' },
];

function ProgressBar({ percent }) {
  const color = percent >= 80 ? '#22c55e' : percent >= 50 ? '#eab308' : '#6b7280';
  return (
    <div className="w-full bg-gray-800 rounded-full h-2">
      <div className="h-2 rounded-full transition-all duration-500" style={{ width: `${percent}%`, backgroundColor: color }} />
    </div>
  );
}

function SectionEditor({ sectionKey, label, hint, value, onChange, onAIEnhance }) {
  const [open, setOpen]       = useState(sectionKey === 'executiveSummary');
  const [enhancing, setEnh]   = useState(false);
  const textRef               = useRef(null);
  const filled                = (value || '').replace(/\[PLACEHOLDER\]/g, '').trim().length > 20;

  const enhance = async () => {
    setEnh(true);
    try {
      const r = await API.post('/proposals/enhance-section', { section: sectionKey, currentText: value });
      onChange(r.data.enhanced);
      toast.success('Section enhanced by AI!');
    } catch { toast.error('Enhancement failed'); }
    finally { setEnh(false); }
  };

  return (
    <div className={`bg-gray-900 rounded-xl border transition-colors ${open ? 'border-green-500/30' : 'border-gray-800'}`}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-5 text-left">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${filled ? 'bg-green-400' : 'bg-gray-600'}`} />
          <span className={`font-medium ${filled ? 'text-white' : 'text-gray-400'}`}>{label}</span>
          {!filled && <span className="text-xs text-gray-600">(incomplete)</span>}
        </div>
        {open ? <ChevronUp size={16} className="text-gray-500" /> : <ChevronDown size={16} className="text-gray-500" />}
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-3">
          <p className="text-gray-500 text-xs">{hint}</p>
          {value?.includes('[PLACEHOLDER]') && (
            <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3">
              <p className="text-yellow-400 text-xs">⚠️ Contains [PLACEHOLDER] fields — fill these in before submitting.</p>
            </div>
          )}
          <textarea
            ref={textRef}
            rows={10}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-gray-200 text-sm leading-relaxed resize-y focus:outline-none focus:border-green-500 font-mono"
            value={value || ''}
            onChange={e => onChange(e.target.value)}
            placeholder={`Write your ${label.toLowerCase()} here...`}
          />
          <div className="flex justify-end">
            <button onClick={enhance} disabled={enhancing}
              className="flex items-center gap-2 px-3 py-1.5 bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 rounded-lg text-xs transition-colors disabled:opacity-50 border border-purple-500/30">
              <Sparkles size={12} /> {enhancing ? 'Enhancing…' : 'AI Enhance Section'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProposalEditor() {
  const { id }      = useParams();
  const navigate    = useNavigate();
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [exporting, setExp]     = useState(false);

  useEffect(() => {
    API.get(`/proposals/${id}`)
      .then(r => setProposal(r.data))
      .catch(() => { toast.error('Proposal not found'); navigate('/proposals'); })
      .finally(() => setLoading(false));
  }, [id, navigate]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await API.put(`/proposals/${id}`, proposal);
      setProposal(r.data);
      toast.success('Saved!');
    } catch { toast.error('Save failed'); }
    finally { setSaving(false); }
  };

  const exportPDF = async () => {
    setExp(true);
    try {
      const r = await API.post(`/proposals/${id}/export`, {}, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `proposal-${id}.pdf`; a.click();
      URL.revokeObjectURL(url);
      toast.success('PDF downloaded!');
    } catch { toast.error('Export failed — try saving first'); }
    finally { setExp(false); }
  };

  const updateSection = (key, val) => {
    setProposal(prev => ({ ...prev, sections: { ...prev.sections, [key]: val } }));
    // Auto-compute completion %
    const filled = SECTIONS.filter(s => (proposal?.sections?.[s.key] || '').replace(/\[PLACEHOLDER\]/g, '').trim().length > 30).length;
    const pct    = Math.round((filled / SECTIONS.length) * 100);
    setProposal(prev => ({ ...prev, completionPercentage: pct }));
  };

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-10 h-10 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );
  if (!proposal) return null;

  return (
    <div className="p-8 max-w-4xl fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-gray-400 hover:text-white text-sm transition-colors">
          <ArrowLeft size={16} /> Back
        </button>
        <div className="flex gap-2">
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white rounded-lg text-sm transition-colors disabled:opacity-50">
            <Save size={14} /> {saving ? 'Saving…' : 'Save Draft'}
          </button>
          <button onClick={exportPDF} disabled={exporting}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors disabled:opacity-50">
            <Download size={14} /> {exporting ? 'Exporting…' : 'Export PDF'}
          </button>
        </div>
      </div>

      {/* Title & tender */}
      <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 mb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <input
              className="w-full bg-transparent text-xl font-bold text-white focus:outline-none placeholder-gray-600"
              value={proposal.title || ''}
              onChange={e => setProposal(p => ({ ...p, title: e.target.value }))}
              placeholder="Proposal title..."
            />
            <p className="text-gray-500 text-sm mt-1">{proposal.tender?.title}</p>
          </div>
          <div className="text-right flex-shrink-0">
            <span className={`text-xs px-2.5 py-1 rounded-full border ${proposal.status === 'draft' ? 'bg-gray-800 border-gray-700 text-gray-400' : 'bg-green-500/15 border-green-500/30 text-green-400'}`}>
              {proposal.status}
            </span>
            {proposal.aiGenerated && (
              <div className="text-xs text-purple-400 mt-1 flex items-center gap-1 justify-end">
                <Sparkles size={10} /> AI Generated
              </div>
            )}
          </div>
        </div>

        {/* Completion progress */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-gray-500">Completion</span>
            <span className="text-xs font-semibold text-white">{proposal.completionPercentage || 0}%</span>
          </div>
          <ProgressBar percent={proposal.completionPercentage || 0} />
          {(proposal.completionPercentage || 0) < 100 && (
            <p className="text-xs text-gray-600 mt-1.5">
              Complete all sections and replace [PLACEHOLDER] fields before submitting.
            </p>
          )}
        </div>
      </div>

      {/* Section editors */}
      <div className="space-y-3">
        {SECTIONS.map(s => (
          <SectionEditor
            key={s.key}
            sectionKey={s.key}
            label={s.label}
            hint={s.hint}
            value={proposal.sections?.[s.key] || ''}
            onChange={val => updateSection(s.key, val)}
          />
        ))}
      </div>

      {/* Status selector */}
      <div className="mt-5 bg-gray-900 rounded-xl p-5 border border-gray-800">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Proposal Status</h3>
        <div className="flex gap-2 flex-wrap">
          {['draft', 'review', 'submitted', 'won', 'lost'].map(s => (
            <button key={s} onClick={() => setProposal(p => ({ ...p, status: s }))}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors border ${proposal.status === s ? 'bg-green-500/20 border-green-500/40 text-green-400' : 'border-gray-700 text-gray-400 hover:bg-gray-800'}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Auto-save notice */}
      <p className="text-center text-gray-600 text-xs mt-6">
        Ctrl+S to save · Changes are not auto-saved · Export creates a formatted PDF
      </p>
    </div>
  );
}
