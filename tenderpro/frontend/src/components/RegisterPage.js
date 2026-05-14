import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { toast } from 'react-hot-toast';
import { Zap, ChevronRight, ChevronLeft, Check } from 'lucide-react';

const API = axios.create({ baseURL: '/api' });

const STEPS = ['Account', 'Company', 'Sectors', 'Locations', 'Done'];

const SECTOR_OPTIONS = [
  'Information Technology','Software Development','Cloud Services','Cybersecurity',
  'Construction & Infrastructure','Roads & Transportation','Water & Sanitation',
  'Healthcare & Medical','Pharmaceuticals','Education & Training',
  'Agriculture & Food Security','Energy & Power','Solar & Renewables',
  'Finance & Banking','Logistics & Supply Chain','Environmental Services',
  'Consulting & Advisory','Security Services','Media & Communications',
  'Legal Services','NGO & Development','Humanitarian Aid'
];

const COUNTRY_OPTIONS = [
  'Kenya','Uganda','Tanzania','Rwanda','Nigeria','Ghana','South Africa',
  'Ethiopia','Zambia','Zimbabwe','Egypt','Morocco','United States',
  'United Kingdom','India','Germany','France','UAE','Saudi Arabia',
  'Australia','Canada','International (UN/World Bank)'
];

export default function RegisterPage() {
  const navigate = useNavigate();
  const [step, setStep]       = useState(0);
  const [loading, setLoading] = useState(false);
  const [form, setForm]       = useState({
    name: '', email: '', password: '', phone: '',
    companyName: '', website: '', description: '', yearsFounded: '',
    sectors: [], targetCountries: [], minBudget: '', maxBudget: ''
  });

  const next = () => setStep(s => Math.min(s + 1, STEPS.length - 1));
  const back = () => setStep(s => Math.max(s - 1, 0));

  const toggleSector = s => setForm(p => ({
    ...p, sectors: p.sectors.includes(s) ? p.sectors.filter(x => x !== s) : [...p.sectors, s]
  }));

  const toggleCountry = c => setForm(p => ({
    ...p, targetCountries: p.targetCountries.includes(c) ? p.targetCountries.filter(x => x !== c) : [...p.targetCountries, c]
  }));

  const submit = async () => {
    setLoading(true);
    try {
      const r = await API.post('/auth/register', {
        name: form.name, email: form.email, password: form.password, phone: form.phone,
        companyName: form.companyName, sectors: form.sectors, targetCountries: form.targetCountries,
        tenderPreferences: { minBudget: parseInt(form.minBudget) || null, maxBudget: parseInt(form.maxBudget) || null }
      });
      localStorage.setItem('token', r.data.token);
      toast.success('Account created! Welcome to TenderPro 🎉');
      navigate('/dashboard');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Registration failed');
    } finally { setLoading(false); }
  };

  const inputCls = "w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-green-500 text-sm transition-colors";

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Zap className="text-green-400" size={28} />
            <span className="text-2xl font-bold text-white">TenderPro AI</span>
          </div>
          <p className="text-gray-500 text-sm">Set up your account in 2 minutes</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center mb-8 gap-2">
          {STEPS.map((s, i) => (
            <React.Fragment key={s}>
              <div className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold transition-colors
                ${i < step ? 'bg-green-500 text-black' : i === step ? 'bg-green-500/20 border border-green-500 text-green-400' : 'bg-gray-800 text-gray-600'}`}>
                {i < step ? <Check size={14} /> : i + 1}
              </div>
              {i < STEPS.length - 1 && <div className={`h-px w-8 ${i < step ? 'bg-green-500' : 'bg-gray-800'}`} />}
            </React.Fragment>
          ))}
        </div>

        <div className="bg-gray-900 rounded-2xl p-8 border border-gray-800">
          <h2 className="text-xl font-semibold text-white mb-6">{STEPS[step]}</h2>

          {/* Step 0 — Account */}
          {step === 0 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4">
                <input className={inputCls} placeholder="Full name" value={form.name} onChange={e => setForm(p => ({...p, name: e.target.value}))} />
                <input className={inputCls} type="email" placeholder="Work email" value={form.email} onChange={e => setForm(p => ({...p, email: e.target.value}))} />
                <input className={inputCls} type="password" placeholder="Password (min 8 chars)" value={form.password} onChange={e => setForm(p => ({...p, password: e.target.value}))} />
                <div className="relative">
                  <span className="absolute left-4 top-3 text-gray-500 text-sm">+</span>
                  <input className={`${inputCls} pl-7`} placeholder="WhatsApp number (e.g. 254712345678)" value={form.phone} onChange={e => setForm(p => ({...p, phone: e.target.value}))} />
                </div>
              </div>
              <p className="text-gray-600 text-xs">Your WhatsApp number receives tender alerts and AI analysis.</p>
            </div>
          )}

          {/* Step 1 — Company */}
          {step === 1 && (
            <div className="space-y-4">
              <input className={inputCls} placeholder="Company name" value={form.companyName} onChange={e => setForm(p => ({...p, companyName: e.target.value}))} />
              <input className={inputCls} placeholder="Website (optional)" value={form.website} onChange={e => setForm(p => ({...p, website: e.target.value}))} />
              <input className={inputCls} type="number" placeholder="Year founded (optional)" value={form.yearsFounded} onChange={e => setForm(p => ({...p, yearsFounded: e.target.value}))} />
              <textarea className={`${inputCls} resize-none`} rows={3} placeholder="Brief company description (used by AI to score tenders)" value={form.description} onChange={e => setForm(p => ({...p, description: e.target.value}))} />
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Min budget (USD)</label>
                  <input className={inputCls} type="number" placeholder="e.g. 10000" value={form.minBudget} onChange={e => setForm(p => ({...p, minBudget: e.target.value}))} />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Max budget (USD)</label>
                  <input className={inputCls} type="number" placeholder="e.g. 5000000" value={form.maxBudget} onChange={e => setForm(p => ({...p, maxBudget: e.target.value}))} />
                </div>
              </div>
            </div>
          )}

          {/* Step 2 — Sectors */}
          {step === 2 && (
            <div>
              <p className="text-gray-400 text-sm mb-4">Select all sectors your company operates in. The agent uses this to score tenders.</p>
              <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
                {SECTOR_OPTIONS.map(s => (
                  <button key={s} onClick={() => toggleSector(s)}
                    className={`text-left px-3 py-2 rounded-lg text-xs transition-colors border ${form.sectors.includes(s) ? 'bg-green-500/20 border-green-500/40 text-green-400' : 'border-gray-700 text-gray-400 hover:bg-gray-800'}`}>
                    {form.sectors.includes(s) && '✓ '}{s}
                  </button>
                ))}
              </div>
              <p className="text-gray-600 text-xs mt-3">{form.sectors.length} selected</p>
            </div>
          )}

          {/* Step 3 — Locations */}
          {step === 3 && (
            <div>
              <p className="text-gray-400 text-sm mb-4">Select target markets. The agent monitors these regions every 6 hours.</p>
              <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
                {COUNTRY_OPTIONS.map(c => (
                  <button key={c} onClick={() => toggleCountry(c)}
                    className={`text-left px-3 py-2 rounded-lg text-xs transition-colors border ${form.targetCountries.includes(c) ? 'bg-blue-500/20 border-blue-500/40 text-blue-400' : 'border-gray-700 text-gray-400 hover:bg-gray-800'}`}>
                    {form.targetCountries.includes(c) && '✓ '}{c}
                  </button>
                ))}
              </div>
              <p className="text-gray-600 text-xs mt-3">{form.targetCountries.length} selected</p>
            </div>
          )}

          {/* Step 4 — Done */}
          {step === 4 && (
            <div className="text-center space-y-4 py-4">
              <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto">
                <Zap size={32} className="text-green-400" />
              </div>
              <h3 className="text-white font-semibold">Ready to launch!</h3>
              <div className="bg-gray-800 rounded-xl p-4 text-left space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Name</span><span className="text-white">{form.name}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Company</span><span className="text-white">{form.companyName}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Sectors</span><span className="text-white">{form.sectors.length} selected</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Countries</span><span className="text-white">{form.targetCountries.length} selected</span></div>
                <div className="flex justify-between"><span className="text-gray-500">WhatsApp</span><span className="text-green-400">+{form.phone}</span></div>
              </div>
              <p className="text-gray-500 text-xs">The agent starts scanning immediately. Expect your first alerts within 15 minutes.</p>
            </div>
          )}

          {/* Navigation */}
          <div className="flex justify-between mt-8 gap-3">
            {step > 0 && (
              <button onClick={back} className="flex items-center gap-2 px-4 py-2.5 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-sm transition-colors">
                <ChevronLeft size={16} /> Back
              </button>
            )}
            <div className="flex-1" />
            {step < STEPS.length - 1 ? (
              <button onClick={next}
                disabled={
                  (step === 0 && (!form.name || !form.email || !form.password || !form.phone)) ||
                  (step === 1 && !form.companyName) ||
                  (step === 2 && form.sectors.length === 0) ||
                  (step === 3 && form.targetCountries.length === 0)
                }
                className="flex items-center gap-2 px-6 py-2.5 bg-green-500 hover:bg-green-400 text-black font-semibold rounded-lg text-sm transition-colors disabled:opacity-40">
                Next <ChevronRight size={16} />
              </button>
            ) : (
              <button onClick={submit} disabled={loading}
                className="flex items-center gap-2 px-6 py-2.5 bg-green-500 hover:bg-green-400 text-black font-semibold rounded-lg text-sm transition-colors disabled:opacity-50">
                <Zap size={16} /> {loading ? 'Creating account…' : 'Launch Agent'}
              </button>
            )}
          </div>
        </div>

        <p className="text-center text-gray-600 text-sm mt-4">
          Already have an account? <Link to="/login" className="text-green-400 hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
