import React, { useState, useEffect, useRef } from 'react';
import { useSocket } from '../App';
import { Zap, Globe, CheckCircle2, AlertTriangle, RefreshCw, Clock } from 'lucide-react';
import axios from 'axios';

const API = axios.create({ baseURL: '/api' });
API.interceptors.request.use(c => {
  const t = localStorage.getItem('token');
  if (t) c.headers.Authorization = `Bearer ${t}`;
  return c;
});

function ActivityItem({ event }) {
  const icons = {
    'tender:new':        { icon: CheckCircle2, color: 'text-green-400' },
    'tender:discovered': { icon: Globe,        color: 'text-blue-400'  },
    'match:new':         { icon: Zap,          color: 'text-yellow-400'},
    'scouting:complete': { icon: CheckCircle2, color: 'text-purple-400'},
    'error':             { icon: AlertTriangle, color: 'text-red-400'  }
  };
  const { icon: Icon, color } = icons[event.type] || { icon: Clock, color: 'text-gray-400' };

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-gray-800 last:border-0">
      <Icon size={14} className={`${color} mt-0.5 flex-shrink-0`} />
      <div className="flex-1 min-w-0">
        <p className="text-gray-300 text-xs leading-relaxed">{event.message}</p>
        <p className="text-gray-600 text-xs mt-0.5">{new Date(event.ts).toLocaleTimeString()}</p>
      </div>
    </div>
  );
}

export default function AgentStatusPanel() {
  const socket = useSocket();
  const [status, setStatus]   = useState({ agent: 'active', lastRound: null, nextRound: null });
  const [events, setEvents]   = useState([]);
  const [credits, setCredits] = useState({ verifiedPortals: 0, lastDiscovery: null });
  const feedRef               = useRef(null);

  useEffect(() => {
    API.get('/api/status').then(r => setStatus(r.data)).catch(() => {});
    API.get('/analytics/agent-credits').then(r => setCredits(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!socket) return;

    const add = (type, msg) => {
      setEvents(prev => [{ type, message: msg, ts: new Date().toISOString(), id: Date.now() }, ...prev].slice(0, 50));
      setTimeout(() => feedRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 50);
    };

    socket.on('tender:new',         d => add('tender:new',        `New tender: ${d.title?.substring(0, 60)} (${d.country})`));
    socket.on('tender:discovered',  d => add('tender:discovered', `Agent found: ${d.title?.substring(0, 60)} in ${d.country}`));
    socket.on('match:new',          d => add('match:new',         `Match: ${d.matchScore}% — ${d.title?.substring(0, 50)}`));
    socket.on('scouting:complete',  d => add('scouting:complete', `Scouting round done in ${d.elapsed}s — ${d.companies} companies`));

    return () => {
      socket.off('tender:new');
      socket.off('tender:discovered');
      socket.off('match:new');
      socket.off('scouting:complete');
    };
  }, [socket]);

  const triggerSearch = async () => {
    try {
      await API.post('/tenders/search/agent', { query: 'active tenders' });
    } catch {}
  };

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-400 pulse-dot" />
          <span className="text-sm font-semibold text-white">Agent Activity</span>
        </div>
        <button onClick={triggerSearch} className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 px-2.5 py-1 rounded-lg transition-colors">
          <RefreshCw size={11} /> Scan now
        </button>
      </div>

      {/* Credit budget */}
      <div className="px-4 py-3 bg-gray-800/50 border-b border-gray-800">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-500">Search Credits (Tavily/Exa)</span>
          <span className="text-xs font-semibold text-green-400">$0 this week</span>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-gray-600">Verified Portals</p>
            <p className="text-white font-medium">{credits.verifiedPortals || 0} saved</p>
          </div>
          <div>
            <p className="text-gray-600">Next Discovery</p>
            <p className="text-white font-medium">{credits.lastDiscovery ? 'Sunday 02:00' : 'Pending'}</p>
          </div>
        </div>
        <p className="text-gray-600 text-xs mt-2">
          Agent visits verified portals directly — search credits used only weekly for new portal discovery.
        </p>
      </div>

      {/* Live feed */}
      <div ref={feedRef} className="p-4 max-h-64 overflow-y-auto">
        {events.length === 0 ? (
          <div className="text-center py-8">
            <Globe size={24} className="text-gray-700 mx-auto mb-2" />
            <p className="text-gray-600 text-xs">Waiting for agent activity…</p>
            <p className="text-gray-700 text-xs mt-1">Events appear here in real time</p>
          </div>
        ) : (
          events.map(e => <ActivityItem key={e.id} event={e} />)
        )}
      </div>
    </div>
  );
}
