import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link, useLocation, useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { io } from 'socket.io-client';
import { Toaster, toast } from 'react-hot-toast';
import {
  LayoutDashboard, Search, FileText, Building2, Settings, LogOut,
  TrendingUp, Zap, Globe, CheckCircle2, AlertTriangle, ArrowLeft,
  ExternalLink, ThumbsUp, ThumbsDown, Calendar, DollarSign, MapPin,
  Shield, Users, ChevronDown, ChevronUp, Sparkles, Save, Download,
  Check, ChevronRight, ChevronLeft, Bell, MessageSquare, Mail,
  CreditCard, Star, Lock, RefreshCw, Clock
} from 'lucide-react';

// ── API client ────────────────────────────────────────────────────────────────
const API = axios.create({ baseURL: '/api', withCredentials: true });
API.interceptors.request.use(c => {
  const t = localStorage.getItem('tp_token');
  if (t) c.headers.Authorization = `Bearer ${t}`;
  return c;
});
API.interceptors.response.use(r => r, e => {
  if (e.response?.status === 401) {
    localStorage.removeItem('tp_token');
    window.location.href = '/login';
  }
  return Promise.reject(e);
});

// ── Contexts ──────────────────────────────────────────────────────────────────
const AuthCtx   = createContext(null);
const SocketCtx = createContext(null);
export const useAuth   = () => useContext(AuthCtx);
export const useSocket = () => useContext(SocketCtx);

// ── Plan config (mirrors backend) ─────────────────────────────────────────────
const PLAN_LIMITS = {
  trial:        { dailySearches: 3,  monthlyAlerts: 10,  draftEnabled: false, calendarEnabled: false },
  free:         { dailySearches: 2,  monthlyAlerts: 5,   draftEnabled: false, calendarEnabled: false },
  starter:      { dailySearches: 10, monthlyAlerts: 20,  draftEnabled: false, calendarEnabled: false },
  professional: { dailySearches: 50, monthlyAlerts: 100, draftEnabled: true,  calendarEnabled: true  },
  enterprise:   { dailySearches: -1, monthlyAlerts: -1,  draftEnabled: true,  calendarEnabled: true  }
};

// ── AuthProvider ──────────────────────────────────────────────────────────────
function AuthProvider({ children }) {
  const [user, setUser]     = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    try {
      const r = await API.get('/auth/me');
      setUser(r.data);
    } catch {
      localStorage.removeItem('tp_token');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (localStorage.getItem('tp_token')) loadMe(); else setLoading(false); }, [loadMe]);

  const login = async (email, password) => {
    const r = await API.post('/auth/login', { email, password });
    localStorage.setItem('tp_token', r.data.token);
    setUser(r.data.user);
    return r.data;
  };

  const logout = async () => {
    try { await API.post('/auth/logout'); } catch {}
    localStorage.removeItem('tp_token');
    setUser(null);
  };

  const refreshUser = () => loadMe();

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-950">
      <div className="text-center">
        <div className="w-10 h-10 border-2 border-green-400 border-t-transparent rounded-full animate-spin mx-auto mb-3"/>
        <p className="text-green-400 text-sm">Loading TenderPro...</p>
      </div>
    </div>
  );

  return <AuthCtx.Provider value={{ user, login, logout, setUser, refreshUser }}>{children}</AuthCtx.Provider>;
}

// ── SocketProvider ────────────────────────────────────────────────────────────
function SocketProvider({ children }) {
  const [socket, setSocket] = useState(null);
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    const s = io(window.location.origin, { withCredentials: true, transports: ['websocket'] });
    s.emit('subscribe:company', user.company?.id || user.company);
    s.on('match:new',          d => toast.success(`🎯 ${d.matchScore}% match — ${d.title?.substring(0, 40)}`));
    s.on('tender:discovered',  d => toast(`📋 ${d.title?.substring(0, 40)} (${d.country})`, { icon: '🔍' }));
    s.on('search:complete',    d => toast.success(`Search complete — ${d.count} results`));
    setSocket(s);
    return () => s.disconnect();
  }, [user]);

  return <SocketCtx.Provider value={socket}>{children}</SocketCtx.Provider>;
}

// ── Trial Banner ──────────────────────────────────────────────────────────────
function TrialBanner() {
  const { user } = useAuth();
  if (!user) return null;
  const plan = user.subscription?.plan;
  const daysLeft = user.trialDaysLeft ?? 0;
  if (!['trial','free'].includes(plan)) return null;

  if (plan === 'trial' && daysLeft <= 0) {
    return (
      <div className="bg-red-900/80 border-b border-red-700 px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2 text-red-200 text-sm">
          <AlertTriangle size={15}/> Your free trial has expired. Upgrade to continue using TenderPro.
        </div>
        <Link to="/upgrade" className="bg-red-500 hover:bg-red-400 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">Upgrade Now</Link>
      </div>
    );
  }

  if (plan === 'trial') {
    const color = daysLeft <= 1 ? 'bg-orange-900/70 border-orange-700' : 'bg-blue-900/60 border-blue-700';
    return (
      <div className={`${color} border-b px-4 py-2 flex items-center justify-between`}>
        <div className="flex items-center gap-2 text-sm text-blue-200">
          <Clock size={14}/> Free trial — <strong>{daysLeft} day{daysLeft !== 1 ? 's' : ''} remaining</strong>
          <span className="text-blue-300">· {PLAN_LIMITS.trial.dailySearches} searches/day · {PLAN_LIMITS.trial.monthlyAlerts} alerts/month</span>
        </div>
        <Link to="/upgrade" className="bg-green-500 hover:bg-green-400 text-black text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors">Upgrade</Link>
      </div>
    );
  }
  return null;
}

// ── Quota badge ───────────────────────────────────────────────────────────────
function QuotaBadge({ used, limit, label }) {
  if (limit === -1) return <span className="text-xs text-green-400">∞ {label}</span>;
  const pct = Math.round((used / limit) * 100);
  const color = pct >= 90 ? 'text-red-400' : pct >= 70 ? 'text-yellow-400' : 'text-gray-400';
  return <span className={`text-xs ${color}`}>{used}/{limit} {label}</span>;
}

// ── Layout ────────────────────────────────────────────────────────────────────
function Layout({ children }) {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const plan = user?.subscription?.plan || 'trial';

  const nav = [
    { path: '/dashboard',  label: 'Dashboard',  icon: LayoutDashboard },
    { path: '/tenders',    label: 'Tenders',    icon: Search },
    { path: '/proposals',  label: 'Proposals',  icon: FileText },
    { path: '/company',    label: 'Company',    icon: Building2 },
    { path: '/analytics',  label: 'Analytics',  icon: TrendingUp },
    { path: '/settings',   label: 'Settings',   icon: Settings },
  ];

  const planColors = { trial:'text-blue-400', free:'text-gray-400', starter:'text-green-400', professional:'text-purple-400', enterprise:'text-yellow-400' };

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col flex-shrink-0">
        <div className="p-5 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Zap className="text-green-400" size={22}/>
            <span className="text-lg font-bold text-white">TenderPro AI</span>
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"/>
            <span className="text-xs text-gray-500">Agent active</span>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {nav.map(({ path, label, icon: Icon }) => (
            <Link key={path} to={path} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${loc.pathname.startsWith(path) ? 'bg-green-500/15 text-green-400 font-medium' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}>
              <Icon size={17}/>{label}
            </Link>
          ))}
          {!['professional','enterprise'].includes(plan) && (
            <Link to="/upgrade" className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-yellow-400 hover:bg-yellow-500/10 mt-2 border border-yellow-500/20">
              <Star size={17}/> Upgrade Plan
            </Link>
          )}
        </nav>

        <div className="p-4 border-t border-gray-800">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-500/30 to-blue-500/30 flex items-center justify-center text-green-400 font-bold border border-gray-700 text-sm">
              {user?.name?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.name}</p>
              <p className={`text-xs capitalize ${planColors[plan]}`}>{plan} plan</p>
            </div>
          </div>
          <button onClick={logout} className="flex items-center gap-2 text-gray-500 hover:text-red-400 text-xs transition-colors">
            <LogOut size={13}/> Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <TrialBanner/>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

// ── LoginPage ─────────────────────────────────────────────────────────────────
function LoginPage() {
  const { login } = useAuth();
  const navigate  = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const submit = async e => {
    e.preventDefault();
    setLoading(true); setErr('');
    try {
      const data = await login(form.email, form.password);
      if (data.trialExpired) {
        navigate('/upgrade');
      } else {
        navigate('/dashboard');
      }
    } catch (e) {
      setErr(e.response?.data?.error || 'Invalid email or password');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-2"><Zap className="text-green-400" size={30}/><span className="text-3xl font-bold text-white">TenderPro AI</span></div>
          <p className="text-gray-400 text-sm">Autonomous Global Tender Scout</p>
        </div>
        <form onSubmit={submit} className="bg-gray-900 rounded-2xl p-8 border border-gray-800 space-y-4">
          <h2 className="text-xl font-semibold text-white">Welcome back</h2>
          {err && <div className="bg-red-500/10 text-red-400 text-sm p-3 rounded-lg border border-red-500/20">{err}</div>}
          <input className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-green-500 text-sm" type="email" placeholder="Email" value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))} required/>
          <input className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-green-500 text-sm" type="password" placeholder="Password" value={form.password} onChange={e=>setForm(p=>({...p,password:e.target.value}))} required/>
          <button type="submit" disabled={loading} className="w-full bg-green-500 hover:bg-green-400 text-black font-semibold py-3 rounded-lg transition-colors disabled:opacity-50">{loading?'Signing in...':'Sign In'}</button>
          <p className="text-center text-gray-500 text-sm">No account? <Link to="/register" className="text-green-400 hover:underline">Start free trial</Link></p>
        </form>
      </div>
    </div>
  );
}

// ── RegisterPage ──────────────────────────────────────────────────────────────
const SECTORS  = ['Information Technology','Software Development','Cloud Services','Cybersecurity','Construction & Infrastructure','Roads & Transportation','Water & Sanitation','Healthcare & Medical','Education & Training','Agriculture & Food Security','Energy & Power','Finance & Banking','Logistics & Supply Chain','Consulting & Advisory','Security Services','NGO & Development'];
const COUNTRIES = ['Kenya','Uganda','Tanzania','Rwanda','Nigeria','Ghana','South Africa','Ethiopia','United States','United Kingdom','India','UAE','Saudi Arabia','International (UN/World Bank)'];
const STEPS = ['Account','Company','Sectors','Markets','Launch'];

function RegisterPage() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ name:'',email:'',password:'',phone:'',companyName:'',description:'',sectors:[],targetCountries:[],minBudget:'',maxBudget:'' });
  const ic = "w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-green-500 text-sm";
  const toggle=(key,val)=>setForm(p=>({...p,[key]:p[key].includes(val)?p[key].filter(x=>x!==val):[...p[key],val]}));
  const disabled=[!form.name||!form.email||!form.password||!form.phone,!form.companyName,form.sectors.length===0,form.targetCountries.length===0,false][step];

  const submit = async () => {
    setLoading(true);
    try {
      const r = await API.post('/auth/register', { ...form, tenderPreferences:{ minBudget:parseInt(form.minBudget)||null, maxBudget:parseInt(form.maxBudget)||null } });
      localStorage.setItem('tp_token', r.data.token);
      setUser(r.data.user);
      toast.success('Welcome to TenderPro! Your 3-day trial has started 🎉');
      navigate('/settings?tab=whatsapp');
    } catch(e) { toast.error(e.response?.data?.error||'Registration failed'); }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <div className="flex items-center justify-center gap-2 mb-1"><Zap className="text-green-400" size={24}/><span className="text-2xl font-bold text-white">TenderPro AI</span></div>
          <p className="text-gray-500 text-sm">Start your 3-day free trial — no credit card needed</p>
        </div>
        <div className="flex items-center justify-center mb-6 gap-1.5">
          {STEPS.map((s,i)=>(
            <React.Fragment key={s}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-all ${i<step?'bg-green-500 text-black':i===step?'ring-2 ring-green-500 bg-gray-900 text-green-400':'bg-gray-800 text-gray-600'}`}>{i<step?<Check size={12}/>:i+1}</div>
              {i<STEPS.length-1&&<div className={`h-px w-6 ${i<step?'bg-green-500':'bg-gray-800'}`}/>}
            </React.Fragment>
          ))}
        </div>
        <div className="bg-gray-900 rounded-2xl p-7 border border-gray-800">
          <h2 className="text-lg font-semibold text-white mb-5">{STEPS[step]}</h2>
          {step===0&&<div className="space-y-3"><input className={ic} placeholder="Full name" value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))}/><input className={ic} type="email" placeholder="Work email" value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))}/><input className={ic} type="password" placeholder="Password (8+ chars)" value={form.password} onChange={e=>setForm(p=>({...p,password:e.target.value}))}/><input className={ic} placeholder="WhatsApp number (e.g. 254712345678)" value={form.phone} onChange={e=>setForm(p=>({...p,phone:e.target.value}))}/><p className="text-xs text-gray-600">You'll connect WhatsApp in Settings after registration to receive tender alerts.</p></div>}
          {step===1&&<div className="space-y-3"><input className={ic} placeholder="Company name" value={form.companyName} onChange={e=>setForm(p=>({...p,companyName:e.target.value}))}/><textarea className={`${ic} resize-none`} rows={3} placeholder="Brief company description" value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))}/><div className="grid grid-cols-2 gap-3"><div><label className="text-xs text-gray-500 mb-1 block">Min budget (USD)</label><input className={ic} type="number" placeholder="10000" value={form.minBudget} onChange={e=>setForm(p=>({...p,minBudget:e.target.value}))}/></div><div><label className="text-xs text-gray-500 mb-1 block">Max budget (USD)</label><input className={ic} type="number" placeholder="5000000" value={form.maxBudget} onChange={e=>setForm(p=>({...p,maxBudget:e.target.value}))}/></div></div></div>}
          {step===2&&<div><p className="text-gray-400 text-sm mb-3">Select your company's sectors.</p><div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto">{SECTORS.map(s=><button key={s} onClick={()=>toggle('sectors',s)} className={`text-left px-3 py-2 rounded-lg text-xs border transition-colors ${form.sectors.includes(s)?'bg-green-500/15 border-green-500/30 text-green-400':'border-gray-700 text-gray-400 hover:bg-gray-800'}`}>{form.sectors.includes(s)&&'✓ '}{s}</button>)}</div><p className="text-xs text-gray-600 mt-2">{form.sectors.length} selected</p></div>}
          {step===3&&<div><p className="text-gray-400 text-sm mb-3">Where should the agent search for tenders?</p><div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto">{COUNTRIES.map(c=><button key={c} onClick={()=>toggle('targetCountries',c)} className={`text-left px-3 py-2 rounded-lg text-xs border transition-colors ${form.targetCountries.includes(c)?'bg-blue-500/15 border-blue-500/30 text-blue-400':'border-gray-700 text-gray-400 hover:bg-gray-800'}`}>{form.targetCountries.includes(c)&&'✓ '}{c}</button>)}</div><p className="text-xs text-gray-600 mt-2">{form.targetCountries.length} selected</p></div>}
          {step===4&&<div className="text-center py-4 space-y-4"><div className="w-14 h-14 bg-green-500/15 rounded-full flex items-center justify-center mx-auto"><Zap size={28} className="text-green-400"/></div><h3 className="text-white font-semibold">Ready to launch!</h3><div className="bg-gray-800 rounded-xl p-4 text-left space-y-2 text-sm">{[['Name',form.name],['Company',form.companyName],['Sectors',`${form.sectors.length} selected`],['Markets',`${form.targetCountries.length} selected`],['Trial','3 days free']].map(([k,v])=><div key={k} className="flex justify-between"><span className="text-gray-500">{k}</span><span className="text-white">{v}</span></div>)}</div><p className="text-xs text-gray-500">After registration, connect your WhatsApp to receive tender alerts.</p></div>}
          <div className="flex justify-between mt-7 gap-3">
            {step>0&&<button onClick={()=>setStep(s=>s-1)} className="flex items-center gap-2 px-4 py-2.5 border border-gray-700 text-gray-400 hover:text-white rounded-lg text-sm"><ChevronLeft size={15}/>Back</button>}
            <div className="flex-1"/>
            {step<STEPS.length-1?<button onClick={()=>setStep(s=>s+1)} disabled={disabled} className="flex items-center gap-2 px-5 py-2.5 bg-green-500 hover:bg-green-400 text-black font-semibold rounded-lg text-sm disabled:opacity-40">Next<ChevronRight size={15}/></button>:<button onClick={submit} disabled={loading} className="flex items-center gap-2 px-5 py-2.5 bg-green-500 hover:bg-green-400 text-black font-semibold rounded-lg text-sm disabled:opacity-50"><Zap size={15}/>{loading?'Creating…':'Start Free Trial'}</button>}
          </div>
        </div>
        <p className="text-center text-gray-600 text-sm mt-4">Have an account? <Link to="/login" className="text-green-400 hover:underline">Sign in</Link></p>
      </div>
    </div>
  );
}

// ── UpgradePage ───────────────────────────────────────────────────────────────
function UpgradePage() {
  const { user, refreshUser } = useAuth();
  const [plans, setPlans]     = useState(null);
  const [loading, setLoading] = useState('');
  const [mpesaPhone, setMpesaPhone] = useState(user?.phone || '');

  useEffect(() => { API.get('/upgrade/plans').then(r=>setPlans(r.data)).catch(()=>{}); }, []);

  const handleMpesa = async (plan) => {
    setLoading(plan);
    try {
      await API.post('/payments/mpesa/initiate', { plan, phone: mpesaPhone });
      toast.success('M-Pesa STK push sent! Enter your PIN on your phone.');
    } catch(e) { toast.error(e.response?.data?.error||'Payment failed'); }
    setLoading('');
  };

  const handleStripe = async (plan) => {
    setLoading(plan+'-stripe');
    try {
      const r = await API.post('/payments/stripe/create-intent', { plan });
      // In production integrate Stripe.js here; for now show the client secret
      toast.success('Stripe payment initiated. Complete in your billing portal.');
    } catch(e) { toast.error(e.response?.data?.error||'Payment failed'); }
    setLoading('');
  };

  const planDetails = {
    starter:      { color:'border-green-500/30',  badge:'bg-green-500/10 text-green-400',  icon:'⭐', features:['20 alerts/month','10 searches/day','WhatsApp alerts','Basic matching'] },
    professional: { color:'border-purple-500/40', badge:'bg-purple-500/10 text-purple-400', icon:'💼', features:['100 alerts/month','50 searches/day','AI proposal drafts','Calendar sync','Win probability','Competitor intel'], popular: true },
    enterprise:   { color:'border-yellow-500/30', badge:'bg-yellow-500/10 text-yellow-400', icon:'🏢', features:['Unlimited alerts','Unlimited searches','Full RAG pipeline','API access','Priority support','Team collaboration'] }
  };

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-bold text-white mb-1">Upgrade TenderPro</h1>
      <p className="text-gray-400 mb-2">Current plan: <span className="text-green-400 capitalize font-medium">{user?.subscription?.plan}</span>
        {user?.trialDaysLeft > 0 && <span className="text-yellow-400 ml-2">· {user.trialDaysLeft} trial days left</span>}
      </p>

      <div className="grid grid-cols-3 gap-5 mt-6">
        {Object.entries(planDetails).map(([planKey, details]) => {
          const p = plans?.plans?.[planKey];
          const isCurrent = user?.subscription?.plan === planKey;
          return (
            <div key={planKey} className={`bg-gray-900 rounded-2xl p-6 border-2 ${isCurrent?'border-green-500':details.color} relative`}>
              {details.popular && <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-purple-500 text-white text-xs font-bold px-3 py-1 rounded-full">MOST POPULAR</div>}
              {isCurrent && <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-green-500 text-black text-xs font-bold px-3 py-1 rounded-full">CURRENT PLAN</div>}
              <div className="text-3xl mb-3">{details.icon}</div>
              <h3 className="text-lg font-bold text-white capitalize mb-1">{planKey}</h3>
              <div className="mb-4">
                <span className="text-3xl font-bold text-white">${p?.price || '—'}</span>
                <span className="text-gray-500 text-sm">/month</span>
                <p className="text-xs text-gray-500 mt-0.5">or KES {p?.priceKES?.toLocaleString()}/month</p>
              </div>
              <ul className="space-y-2 mb-6">
                {details.features.map(f=><li key={f} className="flex items-center gap-2 text-xs text-gray-300"><Check size={12} className="text-green-400 flex-shrink-0"/>{f}</li>)}
              </ul>
              {!isCurrent && (
                <div className="space-y-2">
                  <button onClick={()=>handleMpesa(planKey)} disabled={!!loading} className="w-full bg-green-600 hover:bg-green-500 text-white py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                    {loading===planKey?<><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"/>Processing…</>:'📱 Pay with M-Pesa'}
                  </button>
                  <button onClick={()=>handleStripe(planKey)} disabled={!!loading} className="w-full bg-blue-600 hover:bg-blue-500 text-white py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                    💳 Pay with Card
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 bg-gray-900 rounded-xl p-5 border border-gray-800">
        <p className="text-sm font-medium text-white mb-2">M-Pesa Phone Number</p>
        <div className="flex gap-3">
          <input className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-green-500" placeholder="254712345678" value={mpesaPhone} onChange={e=>setMpesaPhone(e.target.value)}/>
        </div>
        <p className="text-xs text-gray-500 mt-1">Must be the M-Pesa registered number</p>
      </div>
    </div>
  );
}

// ── Settings Page ─────────────────────────────────────────────────────────────
function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const loc = useLocation();
  const [tab, setTab]         = useState(new URLSearchParams(loc.search).get('tab') || 'whatsapp');
  const [settings, setSettings] = useState(null);
  const [saving, setSaving]   = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp]         = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');

  useEffect(() => { API.get('/settings').then(r=>setSettings(r.data)).catch(()=>{}); }, []);

  const saveNotifs = async () => {
    setSaving(true);
    try {
      await API.put('/settings/notifications', settings?.preferences || {});
      toast.success('Preferences saved');
      refreshUser();
    } catch { toast.error('Save failed'); }
    setSaving(false);
  };

  const sendOtp = async () => {
    try {
      if (newPhone) await API.put('/settings/whatsapp/phone', { phone: newPhone });
      await API.post('/auth/whatsapp/send-otp');
      setOtpSent(true);
      toast.success('OTP sent to your WhatsApp number!');
    } catch(e) { toast.error(e.response?.data?.error || 'Failed to send OTP'); }
  };

  const verifyOtp = async () => {
    try {
      await API.post('/auth/whatsapp/verify-otp', { otp });
      toast.success('✅ WhatsApp verified! You will now receive tender alerts.');
      setOtpSent(false); setOtp('');
      refreshUser();
      API.get('/settings').then(r=>setSettings(r.data));
    } catch(e) { toast.error(e.response?.data?.error || 'Invalid OTP'); }
  };

  const saveEmail = async () => {
    try {
      await API.put('/settings/email', { notificationEmail: newEmail || user?.email });
      toast.success('Email updated');
      refreshUser();
    } catch(e) { toast.error(e.response?.data?.error || 'Update failed'); }
  };

  const tabs = [
    { id:'whatsapp', label:'WhatsApp', icon:MessageSquare },
    { id:'email',    label:'Email',    icon:Mail },
    { id:'notifications', label:'Notifications', icon:Bell },
    { id:'plan',     label:'Plan & Quota', icon:CreditCard }
  ];

  const plan = user?.subscription?.plan || 'trial';
  const isPro = ['professional','enterprise'].includes(plan);

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-white mb-6">Settings</h1>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-900 p-1 rounded-xl border border-gray-800 mb-6 w-fit">
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab===t.id?'bg-green-500 text-black':'text-gray-400 hover:text-white'}`}>
            <t.icon size={14}/>{t.label}
          </button>
        ))}
      </div>

      {/* WhatsApp Tab */}
      {tab==='whatsapp' && (
        <div className="space-y-4">
          <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Connect WhatsApp</h2>
            <p className="text-gray-400 text-sm mb-4">Connect your WhatsApp number to receive instant tender alerts, run voice searches, and manage your bids via chat.</p>

            {settings?.whatsapp?.verified ? (
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 flex items-center gap-3">
                <CheckCircle2 size={20} className="text-green-400"/>
                <div>
                  <p className="text-green-400 font-medium">WhatsApp Connected ✓</p>
                  <p className="text-gray-400 text-sm">{settings.whatsapp.phone}</p>
                  {settings.whatsapp.connectedAt && <p className="text-gray-600 text-xs">Connected {new Date(settings.whatsapp.connectedAt).toLocaleDateString()}</p>}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 flex items-start gap-2">
                  <AlertTriangle size={14} className="text-yellow-400 mt-0.5"/>
                  <p className="text-yellow-300 text-xs">WhatsApp not connected. You won't receive tender alerts until you verify.</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Change WhatsApp number (optional)</label>
                  <input className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-green-500" placeholder={`Current: ${user?.phone}`} value={newPhone} onChange={e=>setNewPhone(e.target.value)}/>
                </div>
                {!otpSent ? (
                  <button onClick={sendOtp} className="bg-green-500 hover:bg-green-400 text-black font-semibold px-5 py-2.5 rounded-lg text-sm transition-colors">
                    Send Verification Code
                  </button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-gray-400 text-sm">Enter the 6-digit code sent to your WhatsApp:</p>
                    <div className="flex gap-3">
                      <input className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-green-500 tracking-widest text-center text-lg" placeholder="000000" maxLength={6} value={otp} onChange={e=>setOtp(e.target.value.replace(/\D/g,''))}/>
                      <button onClick={verifyOtp} disabled={otp.length!==6} className="bg-green-500 hover:bg-green-400 text-black font-semibold px-5 rounded-lg text-sm disabled:opacity-50 transition-colors">Verify</button>
                    </div>
                    <button onClick={()=>{setOtpSent(false);setOtp('');}} className="text-gray-500 text-xs hover:text-white">Resend code</button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
            <p className="text-sm font-semibold text-gray-300 mb-3">WhatsApp Commands</p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
              {[['SEARCH [keywords]','Find tenders'],['DRAFT','Generate proposal'],['STATUS','Recent matches'],['INTERESTED','Mark relevant'],['NOT RELEVANT','Skip & learn'],['CALENDAR','Add deadlines'],['COMPETITOR','Market intel'],['UPGRADE','Subscription plans'],['HELP','All commands']].map(([cmd,desc])=>(
                <div key={cmd} className="text-xs"><span className="text-green-400 font-mono">{cmd}</span><span className="text-gray-500"> — {desc}</span></div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Email Tab */}
      {tab==='email' && (
        <div className="space-y-4">
          <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Email Notifications</h2>
            {!isPro && (
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 mb-4 flex items-center gap-2">
                <Lock size={14} className="text-blue-400"/>
                <p className="text-blue-300 text-xs">Email proposal delivery requires Professional plan. <Link to="/upgrade" className="text-green-400 underline">Upgrade</Link></p>
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Email for proposal drafts & digest</label>
                <input className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-green-500" type="email" placeholder={user?.email} value={newEmail} onChange={e=>setNewEmail(e.target.value)}/>
              </div>
              <div className="flex items-center justify-between">
                <div><p className="text-white text-sm">Email Notifications</p><p className="text-gray-500 text-xs">Receive proposal drafts and daily digest</p></div>
                <button onClick={()=>setSettings(p=>({...p,preferences:{...p?.preferences,notifyViaEmail:!p?.preferences?.notifyViaEmail}}))} className={`w-11 h-6 rounded-full transition-colors relative ${settings?.preferences?.notifyViaEmail?'bg-green-500':'bg-gray-700'}`} disabled={!isPro}>
                  <div className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-all ${settings?.preferences?.notifyViaEmail?'left-6':'left-1'}`}/>
                </button>
              </div>
              <button onClick={saveEmail} disabled={!isPro} className="bg-green-500 hover:bg-green-400 text-black font-semibold px-5 py-2.5 rounded-lg text-sm disabled:opacity-50 transition-colors">Save Email Settings</button>
            </div>
          </div>
        </div>
      )}

      {/* Notifications Tab */}
      {tab==='notifications' && settings && (
        <div className="space-y-4">
          <div className="bg-gray-900 rounded-xl p-6 border border-gray-800 space-y-5">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Alert Preferences</h2>
            <div>
              <p className="text-white text-sm mb-2">Alert Frequency</p>
              <div className="flex gap-2">{['instant','daily','weekly'].map(f=><button key={f} onClick={()=>setSettings(p=>({...p,preferences:{...p?.preferences,alertFrequency:f}}))} className={`px-3 py-1.5 rounded-lg text-xs capitalize border transition-colors ${settings?.preferences?.alertFrequency===f?'bg-green-500/15 border-green-500/30 text-green-400':'border-gray-700 text-gray-400 hover:bg-gray-800'}`}>{f}</button>)}</div>
            </div>
            <div>
              <p className="text-white text-sm mb-2">Language</p>
              <select className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-green-500" value={settings?.preferences?.language||'en'} onChange={e=>setSettings(p=>({...p,preferences:{...p?.preferences,language:e.target.value}}))}>
                {[['en','English'],['fr','French'],['sw','Swahili'],['ar','Arabic'],['pt','Portuguese']].map(([v,l])=><option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <p className="text-white text-sm mb-2">Home Currency</p>
              <select className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-green-500" value={settings?.preferences?.currency||'USD'} onChange={e=>setSettings(p=>({...p,preferences:{...p?.preferences,currency:e.target.value}}))}>
                {['USD','KES','NGN','GHS','UGX','TZS','ZAR','GBP','EUR'].map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <button onClick={saveNotifs} disabled={saving} className="bg-green-500 hover:bg-green-400 text-black font-semibold px-5 py-2.5 rounded-lg text-sm disabled:opacity-50 transition-colors">{saving?'Saving…':'Save Preferences'}</button>
          </div>
        </div>
      )}

      {/* Plan & Quota Tab */}
      {tab==='plan' && (
        <div className="space-y-4">
          <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Current Plan</h2>
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-2xl font-bold text-white capitalize">{plan}</p>
                <p className="text-gray-500 text-sm">{user?.subscription?.status}</p>
                {user?.subscription?.trialEndsAt && plan==='trial' && <p className="text-yellow-400 text-xs mt-1">Trial ends: {new Date(user.subscription.trialEndsAt).toDateString()}</p>}
                {user?.subscription?.expiresAt && plan!=='trial' && <p className="text-gray-500 text-xs mt-1">Renews: {new Date(user.subscription.expiresAt).toDateString()}</p>}
              </div>
              <Link to="/upgrade" className="bg-green-500 hover:bg-green-400 text-black font-semibold px-4 py-2 rounded-lg text-sm transition-colors">Upgrade</Link>
            </div>
            <div className="space-y-3">
              {[['Daily Searches',user?.quota?.searchesToday||0,PLAN_LIMITS[plan]?.dailySearches,'searches'],['Monthly Alerts',user?.quota?.alertsThisMonth||0,PLAN_LIMITS[plan]?.monthlyAlerts,'alerts']].map(([label,used,limit,unit])=>(
                <div key={label}>
                  <div className="flex justify-between mb-1"><span className="text-gray-400 text-xs">{label}</span><QuotaBadge used={used} limit={limit} label={unit}/></div>
                  {limit>0&&limit!==-1&&<div className="w-full bg-gray-800 rounded-full h-1.5"><div className="h-1.5 rounded-full transition-all" style={{width:`${Math.min(100,(used/limit)*100)}%`,backgroundColor:used/limit>=0.9?'#ef4444':used/limit>=0.7?'#eab308':'#22c55e'}}/></div>}
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-gray-800 grid grid-cols-2 gap-3 text-xs">
              {[['AI Drafts',PLAN_LIMITS[plan]?.draftEnabled],['Calendar Sync',PLAN_LIMITS[plan]?.calendarEnabled]].map(([f,enabled])=>(
                <div key={f} className={`flex items-center gap-2 ${enabled?'text-green-400':'text-gray-600'}`}>
                  {enabled?<Check size={12}/>:<Lock size={12}/>}{f}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats]   = useState(null);
  const [matches, setMatches] = useState([]);
  const [events, setEvents] = useState([]);
  const socket = useSocket();

  useEffect(() => {
    API.get('/analytics/dashboard').then(r=>setStats(r.data)).catch(()=>{});
    API.get('/tenders/matches?limit=6&minScore=50').then(r=>setMatches(r.data.matches||[])).catch(()=>{});
  }, []);

  useEffect(() => {
    if (!socket) return;
    const add=(type,msg)=>setEvents(p=>[{type,msg,ts:new Date().toISOString(),id:Date.now()},...p].slice(0,30));
    socket.on('tender:new',        d=>add('new',   `New: ${d.title?.substring(0,55)}`));
    socket.on('match:new',         d=>add('match', `Match ${d.matchScore}%: ${d.title?.substring(0,45)}`));
    socket.on('scouting:complete', d=>add('done',  `Scouting done in ${d.elapsed}s`));
    return ()=>{socket.off('tender:new');socket.off('match:new');socket.off('scouting:complete');};
  }, [socket]);

  const plan = user?.subscription?.plan || 'trial';
  const daysLeft = user?.trialDaysLeft ?? 0;

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-0.5">Agent: <span className="text-green-400">● Active</span> · Scouting every 6h · Discovery weekly</p>
      </div>

      {stats&&<div className="grid grid-cols-4 gap-4">{[['Active Tenders',stats.totalActiveTenders?.toLocaleString(),'text-blue-400'],['Matches / Month',stats.matchesThisMonth,'text-green-400'],['Avg Match Score',`${stats.averageMatchScore||0}%`,'text-yellow-400'],['Win Prob Scores',stats.winProbabilityCount,'text-purple-400']].map(([l,v,c])=><div key={l} className="bg-gray-900 rounded-xl p-5 border border-gray-800"><p className="text-gray-500 text-xs mb-1">{l}</p><p className={`text-2xl font-bold ${c}`}>{v||'0'}</p></div>)}</div>}

      <div className="grid grid-cols-3 gap-5">
        <div className="col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Recent Matches</h2>
          {matches.map(m=>{
            const goColor={go:'text-green-400',review:'text-yellow-400',no_go:'text-red-400'}[m.analysis?.goNoGo]||'text-gray-400';
            return(
              <Link key={m._id} to={`/tenders/match/${m._id}`} className="block bg-gray-900 rounded-xl p-5 border border-gray-800 hover:border-gray-700 transition-all">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0"><p className="text-white font-medium truncate">{m.tender?.title}</p><p className="text-gray-500 text-xs mt-1">{m.tender?.location?.country} · {m.tender?.sector}</p>{m.reasoning&&<p className="text-gray-600 text-xs mt-1.5 line-clamp-2">{m.reasoning}</p>}</div>
                  <div className="text-right flex-shrink-0"><div className={`text-lg font-bold ${m.matchScore>=70?'text-green-400':m.matchScore>=50?'text-yellow-400':'text-gray-400'}`}>{m.matchScore}%</div><div className={`text-xs mt-0.5 ${goColor}`}>{m.analysis?.goNoGo?.replace('_','-')||'—'}</div>{m.winProbability?.probability!=null&&<div className="text-xs text-blue-400 mt-0.5">Win: {m.winProbability.probability}%</div>}</div>
                </div>
              </Link>
            );
          })}
          {!matches.length&&<div className="bg-gray-900 rounded-xl p-10 border border-gray-800 text-center"><Globe size={32} className="text-gray-700 mx-auto mb-3"/><p className="text-gray-500">Agent scanning… First matches arrive in ~15 minutes.</p></div>}
        </div>
        <div className="space-y-4">
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <div className="flex items-center gap-2 p-3 border-b border-gray-800"><div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"/><span className="text-xs font-medium text-gray-300">Live Feed</span></div>
            <div className="p-3 space-y-2 max-h-72 overflow-y-auto">
              {events.length===0?<p className="text-gray-600 text-xs text-center py-6">Waiting for events…</p>:events.map(e=><div key={e.id} className="flex items-start gap-2 py-1.5 border-b border-gray-800/50 last:border-0"><div className={`w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0 ${e.type==='match'?'bg-yellow-400':e.type==='done'?'bg-purple-400':'bg-green-400'}`}/><div><p className="text-gray-300 text-xs">{e.msg}</p><p className="text-gray-600 text-xs">{new Date(e.ts).toLocaleTimeString()}</p></div></div>)}
            </div>
          </div>
          {!user?.whatsappVerified&&(
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
              <div className="flex items-start gap-2"><AlertTriangle size={16} className="text-yellow-400 flex-shrink-0 mt-0.5"/><div><p className="text-yellow-300 text-sm font-medium">Connect WhatsApp</p><p className="text-yellow-400/70 text-xs mt-1">Verify your number to receive tender alerts.</p><Link to="/settings?tab=whatsapp" className="text-green-400 text-xs hover:underline mt-2 block">Connect now →</Link></div></div>
            </div>
          )}
          <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-xs font-semibold text-gray-400 mb-3">Today's Quota</p>
            <div className="space-y-2">
              {[['Searches',user?.quota?.searchesToday||0,PLAN_LIMITS[plan]?.dailySearches],['Alerts',user?.quota?.alertsThisMonth||0,PLAN_LIMITS[plan]?.monthlyAlerts]].map(([l,u,lim])=>(
                <div key={l} className="flex justify-between text-xs"><span className="text-gray-500">{l}</span><QuotaBadge used={u} limit={lim} label=""/></div>
              ))}
              {!['professional','enterprise'].includes(plan)&&<Link to="/upgrade" className="text-green-400 text-xs hover:underline block mt-1">Upgrade for more →</Link>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── TendersPage ───────────────────────────────────────────────────────────────
function TendersPage() {
  const { user } = useAuth();
  const [matches, setMatches] = useState([]);
  const [tenders, setTenders] = useState([]);
  const [tab, setTab]         = useState('matches');
  const [search, setSearch]   = useState('');
  const [loading, setLoading] = useState(false);
  const [quotaErr, setQuotaErr] = useState(null);

  useEffect(() => {
    API.get('/tenders/matches?limit=20&minScore=40').then(r=>setMatches(r.data.matches||[])).catch(()=>{});
    API.get('/tenders?limit=20').then(r=>setTenders(r.data.tenders||[])).catch(()=>{});
  }, []);

  const agentSearch = async () => {
    if (!search.trim()) return;
    setLoading(true); setQuotaErr(null);
    try {
      await API.post('/tenders/search/agent', { query: search });
      toast('🤖 Agent scanning…', { icon:'🔍' });
    } catch(e) {
      const err = e.response?.data;
      if (err?.error === 'quota_exceeded') setQuotaErr(err);
      else if (err?.error === 'trial_expired') { toast.error('Trial expired. Upgrade to search.'); }
      else toast.error('Search failed');
    }
    setLoading(false);
  };

  return (
    <div className="p-8 space-y-5">
      <div><h1 className="text-2xl font-bold text-white">Tender Intelligence</h1><p className="text-gray-500 text-sm mt-0.5">Agent-discovered tenders matched to your company</p></div>

      <div className="flex gap-3">
        <input className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-green-500 text-sm" placeholder="Search tenders… (e.g. IT Kenya, Road Construction Uganda)" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>e.key==='Enter'&&agentSearch()}/>
        <button onClick={agentSearch} disabled={loading} className="flex items-center gap-2 px-4 py-2.5 bg-green-500 hover:bg-green-400 text-black font-semibold rounded-lg text-sm disabled:opacity-50"><Zap size={15}/>{loading?'Searching…':'Agent Search'}</button>
      </div>

      {quotaErr&&(
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-2"><AlertTriangle size={15} className="text-yellow-400"/><p className="text-yellow-300 text-sm">{quotaErr.message}</p></div>
          <Link to="/upgrade" className="text-green-400 text-sm hover:underline">Upgrade →</Link>
        </div>
      )}

      <div className="flex gap-1 bg-gray-900 p-1 rounded-lg border border-gray-800 w-fit">
        {[['matches','My Matches'],['all','All Discovered']].map(([k,l])=><button key={k} onClick={()=>setTab(k)} className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab===k?'bg-green-500 text-black':'text-gray-400 hover:text-white'}`}>{l}</button>)}
      </div>

      <div className="space-y-3">
        {(tab==='matches'?matches:tenders).map(item=>{
          const t=tab==='matches'?item.tender:item;
          const m=tab==='matches'?item:null;
          if(!t) return null;
          const days=t.dates?.closingDate?Math.ceil((new Date(t.dates.closingDate)-Date.now())/86400000):null;
          return(
            <Link key={item._id} to={m?`/tenders/match/${item._id}`:`/tenders/${t._id}`} className="block bg-gray-900 rounded-xl p-5 border border-gray-800 hover:border-gray-700 transition-all">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0"><p className="text-white font-medium truncate">{t.title}</p><div className="flex items-center gap-3 mt-1.5"><span className="text-gray-500 text-xs flex items-center gap-1"><MapPin size={11}/>{t.location?.country}</span><span className="text-gray-500 text-xs">{t.sector}</span></div></div>
                <div className="text-right flex-shrink-0">
                  {m&&<div className={`text-lg font-bold ${m.matchScore>=70?'text-green-400':m.matchScore>=50?'text-yellow-400':'text-gray-400'}`}>{m.matchScore}%</div>}
                  {t.financials?.estimatedValue&&<p className="text-green-400 text-sm font-semibold">{t.financials.currency} {t.financials.estimatedValue.toLocaleString()}</p>}
                  {days!==null&&<p className={`text-xs ${days<=7?'text-red-400':days<=14?'text-yellow-400':'text-gray-500'}`}>{days>0?`${days}d left`:'Expired'}</p>}
                </div>
              </div>
            </Link>
          );
        })}
        {!(tab==='matches'?matches:tenders).length&&<div className="text-center py-12 text-gray-500 bg-gray-900 rounded-xl border border-gray-800"><Search size={32} className="mx-auto mb-3 text-gray-700"/><p>No tenders yet. Use Agent Search above.</p></div>}
      </div>
    </div>
  );
}

// ── TenderMatchDetail ─────────────────────────────────────────────────────────
function TenderMatchDetail() {
  const { matchId } = useParams();
  const navigate    = useNavigate();
  const { user }    = useAuth();
  const [match, setMatch]     = useState(null);
  const [tender, setTender]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState(false);

  useEffect(()=>{
    API.get(`/tenders/matches/${matchId}`).then(r=>{setMatch(r.data);setTender(r.data.tender);}).catch(()=>navigate('/tenders')).finally(()=>setLoading(false));
  },[matchId,navigate]);

  const sendFeedback=async action=>{try{await API.post(`/tenders/${matchId}/feedback`,{action});toast.success(action==='interested'?'Marked as interested!':'Feedback saved');}catch{toast.error('Failed');}};
  const generateDraft=async()=>{
    setDrafting(true);
    try{const r=await API.post(`/proposals/generate/${matchId}`);toast.success('Draft created!');navigate(`/proposals/${r.data._id}`);}
    catch(e){
      if(e.response?.status===403) toast.error(e.response.data.message||'Upgrade required');
      else toast.error('Draft generation failed');
    }
    setDrafting(false);
  };

  if(loading) return <div className="flex items-center justify-center h-full"><div className="w-10 h-10 border-2 border-green-400 border-t-transparent rounded-full animate-spin"/></div>;
  if(!match||!tender) return null;

  const goColor={go:'#22c55e',review:'#eab308',no_go:'#ef4444'}[match.analysis?.goNoGo]||'#6b7280';
  const days=tender.dates?.closingDate?Math.ceil((new Date(tender.dates.closingDate)-Date.now())/86400000):null;
  const plan=user?.subscription?.plan||'trial';
  const canDraft=['professional','enterprise'].includes(plan);

  function Ring({score,label,color='#22c55e',size=72}){const r=size/2-7;const c=2*Math.PI*r;const d=(score/100)*c;return <div className="flex flex-col items-center"><svg width={size} height={size} className="-rotate-90"><circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1f2937" strokeWidth="5"/><circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="5" strokeDasharray={`${d} ${c}`} strokeLinecap="round"/></svg><span className="text-lg font-bold text-white -mt-10">{score}%</span><span className="text-xs text-gray-500 mt-7">{label}</span></div>;}

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-5">
        <button onClick={()=>navigate(-1)} className="flex items-center gap-2 text-gray-400 hover:text-white text-sm"><ArrowLeft size={15}/>Back</button>
        <div className="flex gap-2">
          <button onClick={()=>sendFeedback('interested')} className="flex items-center gap-2 px-4 py-2 border border-gray-700 text-gray-300 hover:bg-gray-800 rounded-lg text-sm"><ThumbsUp size={13}/>Interested</button>
          <button onClick={()=>sendFeedback('not_relevant')} className="flex items-center gap-2 px-4 py-2 border border-gray-700 text-gray-300 hover:bg-gray-800 rounded-lg text-sm"><ThumbsDown size={13}/>Not Relevant</button>
          {canDraft?<button onClick={generateDraft} disabled={drafting} className="flex items-center gap-2 px-4 py-2 bg-green-500 hover:bg-green-400 text-black font-semibold rounded-lg text-sm disabled:opacity-50"><FileText size={13}/>{drafting?'Drafting…':'Draft Proposal'}</button>:<Link to="/upgrade" className="flex items-center gap-2 px-4 py-2 border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10 rounded-lg text-sm"><Lock size={13}/>Upgrade for Drafts</Link>}
        </div>
      </div>

      <div className="bg-gray-900 rounded-2xl p-6 border border-gray-800 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-white">{tender.title}</h1>
            <div className="flex items-center gap-4 mt-2"><span className="flex items-center gap-1.5 text-gray-400 text-sm"><MapPin size={13}/>{tender.location?.country}{tender.location?.region?`, ${tender.location.region}`:''}</span><span className="text-gray-400 text-sm">{tender.sector}</span></div>
          </div>
          <a href={tender.source?.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-green-400 hover:text-green-300 text-sm border border-green-500/30 px-3 py-1.5 rounded-lg flex-shrink-0"><ExternalLink size={13}/>Source</a>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800 flex flex-col items-center justify-center"><Ring score={match.matchScore||0} label="Match"/></div>
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800 flex flex-col items-center justify-center"><div className="text-2xl font-black" style={{color:goColor}}>{({go:'GO ✅',review:'REVIEW 🔍',no_go:'NO-GO ❌'})[match.analysis?.goNoGo]||'—'}</div><p className="text-xs text-gray-500 mt-1">Go/No-Go</p></div>
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800 flex flex-col items-center justify-center">{match.winProbability?.probability!=null?<Ring score={match.winProbability.probability} label="Win Prob" color="#3b82f6"/>:<p className="text-gray-600 text-xs text-center">Win prob<br/>N/A</p>}</div>
        <div className="bg-gray-900 rounded-xl p-4 border border-gray-800 flex flex-col items-center justify-center"><Ring score={match.confidenceScore||0} label="Confidence" color="#a855f7"/></div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
          {match.reasoning&&<div className="bg-gray-900 rounded-xl p-5 border border-gray-800"><h3 className="text-sm font-semibold text-gray-300 mb-2 flex items-center gap-2"><Zap size={13} className="text-green-400"/>AI Analysis</h3><p className="text-gray-300 text-sm leading-relaxed">{match.reasoning}</p></div>}
          {(match.analysis?.strengths?.length>0||match.analysis?.risks?.length>0||match.analysis?.dealBreakers?.length>0)&&<div className="bg-gray-900 rounded-xl p-5 border border-gray-800 space-y-4">
            {match.analysis.strengths?.length>0&&<div><p className="text-xs font-semibold text-green-400 uppercase mb-2">Strengths</p><ul className="space-y-1.5">{match.analysis.strengths.map((s,i)=><li key={i} className="flex items-start gap-2 text-sm text-gray-300"><CheckCircle2 size={13} className="text-green-400 mt-0.5 flex-shrink-0"/>{s}</li>)}</ul></div>}
            {match.analysis.risks?.length>0&&<div><p className="text-xs font-semibold text-yellow-400 uppercase mb-2">Risks</p><ul className="space-y-1.5">{match.analysis.risks.map((r,i)=><li key={i} className="flex items-start gap-2 text-sm text-gray-300"><AlertTriangle size={13} className="text-yellow-400 mt-0.5 flex-shrink-0"/>{r}</li>)}</ul></div>}
            {match.analysis.dealBreakers?.length>0&&<div><p className="text-xs font-semibold text-red-400 uppercase mb-2">Deal Breakers</p><ul className="space-y-1.5">{match.analysis.dealBreakers.map((d,i)=><li key={i} className="flex items-start gap-2 text-sm text-gray-300"><AlertTriangle size={13} className="text-red-400 mt-0.5 flex-shrink-0"/>{d}</li>)}</ul></div>}
          </div>}
          {match.shadowConflicts?.length>0&&<div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-4"><h3 className="text-sm font-semibold text-orange-400 mb-2 flex items-center gap-2"><AlertTriangle size={13}/>Verification Required</h3><p className="text-orange-300/80 text-xs">Two AI models disagreed. Verify against source before bidding.</p></div>}
          {tender.description&&<div className="bg-gray-900 rounded-xl p-5 border border-gray-800"><h3 className="text-sm font-semibold text-gray-300 mb-2">Description</h3><p className="text-gray-400 text-sm leading-relaxed">{tender.description}</p></div>}
        </div>
        <div className="space-y-4">
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800"><h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2"><Clock size={13}/>Dates</h3><div className="space-y-2">{tender.dates?.closingDate&&<div><p className="text-xs text-red-400">Deadline</p><p className={`text-sm font-semibold ${days<=7?'text-red-400':days<=14?'text-yellow-400':'text-green-400'}`}>{new Date(tender.dates.closingDate).toDateString()}{days!=null&&<span className="ml-2 text-xs font-normal text-gray-500">({days>0?`${days}d`:'EXPIRED'})</span>}</p></div>}</div></div>
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800"><h3 className="text-sm font-semibold text-gray-300 mb-2 flex items-center gap-2"><DollarSign size={13}/>Budget</h3>{tender.financials?.estimatedValue?<p className="text-2xl font-bold text-green-400">{tender.financials.currency} {tender.financials.estimatedValue.toLocaleString()}</p>:<p className="text-gray-500 text-sm">Not disclosed</p>}</div>
          {match.competitorInsight?.usualWinners?.length>0&&<div className="bg-gray-900 rounded-xl p-5 border border-gray-800"><h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2"><TrendingUp size={13} className="text-purple-400"/>Competitor Intel</h3><div className="space-y-2">{match.competitorInsight.usualWinners.map((c,i)=><div key={i} className="flex justify-between"><div><p className="text-gray-300 text-sm">{c.name}</p><p className="text-gray-600 text-xs">{c.wins} wins</p></div><p className="text-green-400 text-sm font-semibold">{c.currency} {c.avgBid?.toLocaleString()}</p></div>)}</div></div>}
          <div className="bg-gray-900 rounded-xl p-5 border border-gray-800"><h3 className="text-sm font-semibold text-gray-300 mb-2 flex items-center gap-2"><Shield size={13} className="text-green-400"/>Verified Source</h3><p className="text-gray-400 text-sm">{tender.source?.name}</p><a href={tender.source?.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-green-400 text-xs hover:underline mt-1 break-all"><ExternalLink size={10}/>{tender.source?.url?.substring(0,45)}…</a></div>
        </div>
      </div>
    </div>
  );
}

// ── ProposalsPage ─────────────────────────────────────────────────────────────
function ProposalsPage() {
  const [proposals, setProposals] = useState([]);
  useEffect(()=>{API.get('/proposals').then(r=>setProposals(r.data||[])).catch(()=>{});}, []);
  return (
    <div className="p-8 space-y-5">
      <div><h1 className="text-2xl font-bold text-white">Proposals</h1><p className="text-gray-500 text-sm">AI-generated draft proposals</p></div>
      <div className="space-y-3">
        {proposals.map(p=>(
          <Link key={p._id} to={`/proposals/${p._id}`} className="block bg-gray-900 rounded-xl p-5 border border-gray-800 hover:border-gray-700 transition-all">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0"><p className="text-white font-medium">{p.title}</p><p className="text-gray-500 text-sm mt-1 truncate">{p.tender?.title}</p><div className="flex items-center gap-3 mt-2"><span className={`text-xs px-2 py-0.5 rounded-full border ${p.status==='submitted'?'bg-blue-500/15 border-blue-500/30 text-blue-400':p.status==='won'?'bg-green-500/15 border-green-500/30 text-green-400':'bg-gray-800 border-gray-700 text-gray-400'}`}>{p.status}</span>{p.aiGenerated&&<span className="text-xs text-purple-400 flex items-center gap-1"><Sparkles size={10}/>AI</span>}<span className="text-xs text-gray-500">{p.completionPercentage||0}% complete</span></div></div>
              <span className="text-green-400 text-sm flex-shrink-0">Edit →</span>
            </div>
          </Link>
        ))}
        {!proposals.length&&<div className="text-center py-12 text-gray-500 bg-gray-900 rounded-xl border border-gray-800"><FileText size={32} className="mx-auto mb-3 text-gray-700"/><p>No proposals yet.</p><p className="text-sm mt-1">Click "Draft Proposal" on any tender match (Professional plan required).</p></div>}
      </div>
    </div>
  );
}

// ── ProposalEditor ────────────────────────────────────────────────────────────
const SECS=[{key:'executiveSummary',label:'Executive Summary'},{key:'technicalApproach',label:'Technical Approach'},{key:'methodology',label:'Methodology & Timeline'},{key:'teamComposition',label:'Team Composition'},{key:'pastPerformance',label:'Past Performance'},{key:'financialProposal',label:'Financial Proposal'},{key:'compliance',label:'Compliance Statement'}];

function ProposalEditor() {
  const {id}=useParams();const navigate=useNavigate();
  const [p,setP]=useState(null);const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);const [open,setOpen]=useState('executiveSummary');
  useEffect(()=>{API.get(`/proposals/${id}`).then(r=>setP(r.data)).catch(()=>navigate('/proposals')).finally(()=>setLoading(false));}, [id,navigate]);
  const save=async()=>{setSaving(true);try{const r=await API.put(`/proposals/${id}`,p);setP(r.data);toast.success('Saved!');}catch{toast.error('Save failed');}setSaving(false);};
  const exportPDF=async()=>{try{const r=await API.post(`/proposals/${id}/export`,{},{responseType:'blob'});const url=URL.createObjectURL(r.data);const a=document.createElement('a');a.href=url;a.download=`proposal-${id}.pdf`;a.click();URL.revokeObjectURL(url);}catch{toast.error('Export failed');}};
  const pct=p?Math.round(SECS.filter(s=>(p.sections?.[s.key]||'').replace(/\[PLACEHOLDER\]/g,'').trim().length>30).length/SECS.length*100):0;
  if(loading) return <div className="flex items-center justify-center h-full"><div className="w-10 h-10 border-2 border-green-400 border-t-transparent rounded-full animate-spin"/></div>;
  if(!p) return null;
  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-5">
        <button onClick={()=>navigate(-1)} className="flex items-center gap-2 text-gray-400 hover:text-white text-sm"><ArrowLeft size={15}/>Back</button>
        <div className="flex gap-2">
          <button onClick={save} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white rounded-lg text-sm disabled:opacity-50"><Save size={13}/>{saving?'Saving…':'Save'}</button>
          <button onClick={exportPDF} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm"><Download size={13}/>PDF</button>
        </div>
      </div>
      <div className="bg-gray-900 rounded-xl p-5 border border-gray-800 mb-4">
        <input className="w-full bg-transparent text-xl font-bold text-white focus:outline-none" value={p.title||''} onChange={e=>setP(prev=>({...prev,title:e.target.value}))} placeholder="Proposal title..."/>
        <p className="text-gray-500 text-sm mt-1">{p.tender?.title}</p>
        <div className="mt-3"><div className="flex justify-between mb-1"><span className="text-xs text-gray-500">Completion</span><span className="text-xs font-semibold text-white">{pct}%</span></div><div className="w-full bg-gray-800 rounded-full h-1.5"><div className="h-1.5 rounded-full transition-all" style={{width:`${pct}%`,backgroundColor:pct>=80?'#22c55e':pct>=50?'#eab308':'#6b7280'}}/></div></div>
      </div>
      <div className="space-y-2">
        {SECS.map(s=>{const filled=(p.sections?.[s.key]||'').replace(/\[PLACEHOLDER\]/g,'').trim().length>30;const isOpen=open===s.key;return(
          <div key={s.key} className={`bg-gray-900 rounded-xl border transition-colors ${isOpen?'border-green-500/30':'border-gray-800'}`}>
            <button onClick={()=>setOpen(isOpen?null:s.key)} className="w-full flex items-center justify-between p-4 text-left">
              <div className="flex items-center gap-3"><div className={`w-2 h-2 rounded-full ${filled?'bg-green-400':'bg-gray-700'}`}/><span className={`text-sm font-medium ${filled?'text-white':'text-gray-400'}`}>{s.label}</span></div>
              {isOpen?<ChevronUp size={15} className="text-gray-500"/>:<ChevronDown size={15} className="text-gray-500"/>}
            </button>
            {isOpen&&<div className="px-4 pb-4">
              {(p.sections?.[s.key]||'').includes('[PLACEHOLDER]')&&<div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-2 mb-2"><p className="text-yellow-400 text-xs">⚠️ Contains [PLACEHOLDER] — fill before submitting</p></div>}
              <textarea rows={10} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-gray-200 text-sm leading-relaxed resize-y focus:outline-none focus:border-green-500" value={p.sections?.[s.key]||''} onChange={e=>setP(prev=>({...prev,sections:{...prev.sections,[s.key]:e.target.value}}))} placeholder={`Write your ${s.label.toLowerCase()}…`}/>
            </div>}
          </div>
        );})}
      </div>
    </div>
  );
}

// ── CompanyPage ───────────────────────────────────────────────────────────────
function CompanyPage() {
  const [company,setCompany]=useState(null);const [saving,setSaving]=useState(false);
  useEffect(()=>{API.get('/company/profile').then(r=>setCompany(r.data)).catch(()=>{});}, []);
  const save=async()=>{setSaving(true);try{await API.put('/company/profile',company);toast.success('Profile saved!');}catch{toast.error('Save failed');}setSaving(false);};
  if(!company) return <div className="p-8 text-gray-500">Loading…</div>;
  const ic="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-green-500 text-sm";
  return (
    <div className="p-8 max-w-3xl space-y-5">
      <div><h1 className="text-2xl font-bold text-white">Company Profile</h1><p className="text-gray-500 text-sm mt-0.5">The agent uses this to score every tender it finds</p></div>
      <div className="bg-gray-900 rounded-xl p-6 border border-gray-800 space-y-4">
        <input className={ic} placeholder="Company name" value={company.name||''} onChange={e=>setCompany(p=>({...p,name:e.target.value}))}/>
        <textarea className={`${ic} resize-none`} rows={3} placeholder="Company description" value={company.description||''} onChange={e=>setCompany(p=>({...p,description:e.target.value}))}/>
        <input className={ic} placeholder="Services (comma-separated)" value={(company.services||[]).join(', ')} onChange={e=>setCompany(p=>({...p,services:e.target.value.split(',').map(s=>s.trim())}))}/>
        <input className={ic} placeholder="Target countries (comma-separated)" value={(company.targetLocations||[]).map(l=>l.country).join(', ')} onChange={e=>setCompany(p=>({...p,targetLocations:e.target.value.split(',').map(s=>({country:s.trim()}))}))}/>
        <div className="grid grid-cols-2 gap-3"><div><label className="text-xs text-gray-500 mb-1 block">Min budget (USD)</label><input type="number" className={ic} value={company.tenderPreferences?.minBudget||''} onChange={e=>setCompany(p=>({...p,tenderPreferences:{...p.tenderPreferences,minBudget:parseInt(e.target.value)||null}}))}/></div><div><label className="text-xs text-gray-500 mb-1 block">Max budget (USD)</label><input type="number" className={ic} value={company.tenderPreferences?.maxBudget||''} onChange={e=>setCompany(p=>({...p,tenderPreferences:{...p.tenderPreferences,maxBudget:parseInt(e.target.value)||null}}))}/></div></div>
      </div>
      <div className="bg-gray-900 rounded-xl p-6 border border-gray-800 space-y-3">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Knowledge Base</h2>
        <p className="text-gray-500 text-sm">Upload PDFs: capability statements, past proposals, certifications.</p>
        <input type="file" accept=".pdf,.txt,.docx" onChange={async e=>{const f=e.target.files[0];if(!f)return;const fd=new FormData();fd.append('document',f);fd.append('documentType','capability_statement');try{await API.post('/company/documents/upload',fd);toast.success(`${f.name} uploaded`);}catch{toast.error('Upload failed');}}} className="text-gray-400 text-sm"/>
        {company.knowledgeBase?.documents?.length>0&&<div className="space-y-1.5">{company.knowledgeBase.documents.slice(0,5).map((d,i)=><div key={i} className="flex justify-between bg-gray-800 rounded-lg px-3 py-2"><span className="text-gray-300 text-xs truncate">{d.name}</span><span className={`text-xs ${d.indexed?'text-green-400':'text-yellow-400'}`}>{d.indexed?'Indexed':'Pending'}</span></div>)}</div>}
      </div>
      <button onClick={save} disabled={saving} className="bg-green-500 hover:bg-green-400 text-black font-semibold px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50">{saving?'Saving…':'Save Profile'}</button>
    </div>
  );
}

// ── Analytics ─────────────────────────────────────────────────────────────────
function AnalyticsPage() {
  const [stats,setStats]=useState(null);
  useEffect(()=>{API.get('/analytics/dashboard').then(r=>setStats(r.data)).catch(()=>{});}, []);
  return (
    <div className="p-8 space-y-6">
      <div><h1 className="text-2xl font-bold text-white">Analytics</h1></div>
      {stats?<>
        <div className="grid grid-cols-4 gap-4">{[['Active Tenders',stats.totalActiveTenders?.toLocaleString(),'text-blue-400'],['This Month',stats.matchesThisMonth,'text-green-400'],['Avg Match Score',`${stats.averageMatchScore||0}%`,'text-yellow-400'],['Win Prob Data',stats.winProbabilityCount,'text-purple-400']].map(([l,v,c])=><div key={l} className="bg-gray-900 rounded-xl p-5 border border-gray-800"><p className="text-gray-500 text-xs mb-1">{l}</p><p className={`text-2xl font-bold ${c}`}>{v||'0'}</p></div>)}</div>
        {stats.topMatchingSectors?.length>0&&<div className="bg-gray-900 rounded-xl p-6 border border-gray-800"><h3 className="text-sm font-semibold text-white mb-5">Top Matching Sectors</h3><div className="space-y-4">{stats.topMatchingSectors.map(s=><div key={s._id} className="flex items-center gap-4"><span className="text-gray-300 text-sm w-52 truncate">{s._id||'General'}</span><div className="flex-1 bg-gray-800 rounded-full h-2"><div className="bg-green-400 h-2 rounded-full" style={{width:`${Math.min(100,s.count*12)}%`}}/></div><span className="text-gray-500 text-xs">{s.count} · {Math.round(s.avgScore)}%</span></div>)}</div></div>}
      </>:<div className="text-gray-500">Loading…</div>}
    </div>
  );
}

// ── Protected + Layout wrapper ────────────────────────────────────────────────
function Protected({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace/>;
  return <Layout><SocketProvider>{children}</SocketProvider></Layout>;
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <Router>
      <AuthProvider>
        <Toaster position="top-right" toastOptions={{ style:{ background:'#1f2937', color:'#f9fafb', border:'1px solid #374151' }, success:{ iconTheme:{ primary:'#22c55e', secondary:'#000' } } }}/>
        <Routes>
          <Route path="/login"    element={<LoginPage/>}/>
          <Route path="/register" element={<RegisterPage/>}/>
          <Route path="/"         element={<Navigate to="/dashboard" replace/>}/>
          <Route path="/dashboard"              element={<Protected><Dashboard/></Protected>}/>
          <Route path="/tenders"                element={<Protected><TendersPage/></Protected>}/>
          <Route path="/tenders/match/:matchId" element={<Protected><TenderMatchDetail/></Protected>}/>
          <Route path="/proposals"              element={<Protected><ProposalsPage/></Protected>}/>
          <Route path="/proposals/:id"          element={<Protected><ProposalEditor/></Protected>}/>
          <Route path="/company"                element={<Protected><CompanyPage/></Protected>}/>
          <Route path="/analytics"              element={<Protected><AnalyticsPage/></Protected>}/>
          <Route path="/settings"               element={<Protected><SettingsPage/></Protected>}/>
          <Route path="/upgrade"                element={<Protected><UpgradePage/></Protected>}/>
        </Routes>
      </AuthProvider>
    </Router>
  );
}
