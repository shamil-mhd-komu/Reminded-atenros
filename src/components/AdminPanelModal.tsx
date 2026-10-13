import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Shield,
  Server,
  Bot,
  Power,
  RotateCw,
  Copy,
  Eye,
  EyeOff,
  Trash2,
  ExternalLink,
  Search,
  RefreshCw,
  Check,
  AlertCircle,
  Plus,
  Users,
  Activity,
  X,
  LogOut,
  Globe,
  Terminal,
} from 'lucide-react';
import type { ServerProfile } from '../types/aternos.ts';

interface AdminPanelModalProps {
  isOpen: boolean;
  onClose: () => void;
  adminToken: string;
  adminUsername: string;
  onSelectServerToMonitor: (server: ServerProfile) => void;
  onLogout: () => void;
}

export const AdminPanelModal: React.FC<AdminPanelModalProps> = ({
  isOpen,
  onClose,
  adminToken,
  onSelectServerToMonitor,
  onLogout,
}) => {
  const [activeTab, setActiveTab] = useState<'servers' | 'discord' | 'add'>('servers');
  const [servers, setServers] = useState<any[]>([]);
  const [botStatus, setBotStatus] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterSource, setFilterSource] = useState<'all' | 'web' | 'discord'>('all');
  const [revealedCookies, setRevealedCookies] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // New server form state
  const [newServerAddress, setNewServerAddress] = useState('');
  const [newSessionCookie, setNewSessionCookie] = useState('');
  const [newServerCookie, setNewServerCookie] = useState('');
  const [newSoftware, setNewSoftware] = useState('Paper / Bukkit');
  const [newVersion, setNewVersion] = useState('1.20.4');

  const fetchAdminData = async () => {
    setIsLoading(true);
    try {
      const sRes = await fetch('/api/admin/servers', {
        headers: { 'x-admin-token': adminToken },
      });
      if (sRes.ok) {
        const sData = await sRes.json();
        if (sData.success && Array.isArray(sData.servers)) {
          setServers(sData.servers);
        }
      }

      const bRes = await fetch('/api/admin/bot-status', {
        headers: { 'x-admin-token': adminToken },
      });
      if (bRes.ok) {
        const bData = await bRes.json();
        setBotStatus(bData);
      }
    } catch (err: any) {
      console.error('Failed to load admin data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchAdminData();
      const interval = setInterval(fetchAdminData, 8000);
      return () => clearInterval(interval);
    }
  }, [isOpen, adminToken]);

  if (!isOpen) return null;

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const toggleReveal = (id: string) => {
    setRevealedCookies(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleAction = async (action: 'start' | 'stop' | 'restart', server: any) => {
    const key = `${server.id}-${action}`;
    setActionLoading(key);
    setMessage(null);

    try {
      const res = await fetch('/api/admin/servers/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': adminToken,
        },
        body: JSON.stringify({
          action,
          serverAddress: server.serverIp || server.name,
          sessionCookie: server.sessionCookie,
          serverCookie: server.serverCookie,
          serverId: server.id,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: `Action [${action.toUpperCase()}] sent for ${server.serverIp}` });
        fetchAdminData();
      } else {
        setMessage({ type: 'error', text: data.message || `Failed to execute ${action}` });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Network error' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this server profile from the database?')) return;
    try {
      const res = await fetch(`/api/admin/servers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': adminToken },
      });
      if (res.ok) {
        setServers(prev => prev.filter(s => s.id !== id));
        setMessage({ type: 'success', text: 'Server profile removed.' });
      }
    } catch {}
  };

  const handleCreateServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerAddress.trim() || !newSessionCookie.trim()) {
      setMessage({ type: 'error', text: 'Server address and Session Cookie required.' });
      return;
    }

    try {
      const res = await fetch('/api/admin/servers/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': adminToken,
        },
        body: JSON.stringify({
          profile: {
            id: `srv-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            name: newServerAddress.trim(),
            serverIp: newServerAddress.trim(),
            serverPort: '25565',
            software: newSoftware,
            version: newVersion,
            sessionCookie: newSessionCookie.trim(),
            serverCookie: newServerCookie.trim(),
            source: 'admin',
          },
        }),
      });

      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: `Server profile registered: ${newServerAddress}` });
        setNewServerAddress('');
        setNewSessionCookie('');
        setNewServerCookie('');
        setActiveTab('servers');
        fetchAdminData();
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Failed to create server.' });
    }
  };

  const filteredServers = servers.filter(s => {
    const matchesSearch =
      (s.serverIp || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.discordUser || '').toLowerCase().includes(searchQuery.toLowerCase());

    const matchesSource =
      filterSource === 'all' ||
      (filterSource === 'web' && s.source !== 'discord') ||
      (filterSource === 'discord' && s.source === 'discord');

    return matchesSearch && matchesSource;
  });

  const onlineServersCount = servers.filter(s => s.liveStatus === 'online').length;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/85 backdrop-blur-lg">
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          className="relative w-full max-w-5xl h-[94dvh] sm:h-[88vh] max-h-[850px] bg-zinc-950 border border-emerald-500/30 rounded-2xl sm:rounded-3xl flex flex-col shadow-2xl shadow-emerald-950/50 overflow-hidden"
        >
          {/* Top Bar Header */}
          <div className="px-3.5 sm:px-6 py-3 sm:py-4 border-b border-white/10 bg-zinc-900/60 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
              <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl sm:rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
                <Shield className="w-4 h-4 sm:w-5 sm:h-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <h2 className="text-sm sm:text-base font-bold text-white tracking-tight truncate">
                    Admin Command Center
                  </h2>
                  <span className="px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 rounded-md border border-emerald-500/30 shrink-0">
                    ROOT
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400 truncate hidden sm:block">
                  Master database & credentials inspection
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              <button
                onClick={fetchAdminData}
                disabled={isLoading}
                className="p-1.5 sm:p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                title="Refresh database"
              >
                <RefreshCw className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${isLoading ? 'animate-spin text-emerald-400' : ''}`} />
              </button>
              <button
                onClick={onLogout}
                className="flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 text-rose-400 text-xs font-semibold transition-colors cursor-pointer"
                title="Sign out of admin"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Logout</span>
              </button>
              <button
                onClick={onClose}
                className="p-1.5 sm:p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              </button>
            </div>
          </div>

          {/* KPI Metrics Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-3.5 sm:px-6 py-2.5 sm:py-3 bg-zinc-900/30 border-b border-white/5 shrink-0">
            <div className="p-2 sm:p-2.5 rounded-xl bg-zinc-900/80 border border-white/5 flex items-center gap-2 sm:gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
                <Server className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <span className="text-[9px] text-zinc-400 uppercase font-semibold block leading-tight">Total</span>
                <p className="text-sm sm:text-base font-bold text-white leading-tight">{servers.length}</p>
              </div>
            </div>

            <div className="p-2 sm:p-2.5 rounded-xl bg-zinc-900/80 border border-white/5 flex items-center gap-2 sm:gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                <Activity className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <span className="text-[9px] text-zinc-400 uppercase font-semibold block leading-tight">Online</span>
                <p className="text-sm sm:text-base font-bold text-emerald-400 leading-tight">{onlineServersCount}</p>
              </div>
            </div>

            <div className="p-2 sm:p-2.5 rounded-xl bg-zinc-900/80 border border-white/5 flex items-center gap-2 sm:gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 shrink-0">
                <Bot className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <span className="text-[9px] text-zinc-400 uppercase font-semibold block leading-tight">Bot</span>
                <p className="text-xs font-bold text-white truncate leading-tight flex items-center gap-1">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${botStatus?.isReady ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <span className="truncate">{botStatus?.botTag || 'Aternos Bot'}</span>
                </p>
              </div>
            </div>

            <div className="p-2 sm:p-2.5 rounded-xl bg-zinc-900/80 border border-white/5 flex items-center gap-2 sm:gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
                <Users className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <span className="text-[9px] text-zinc-400 uppercase font-semibold block leading-tight">Guilds</span>
                <p className="text-sm sm:text-base font-bold text-white leading-tight">{botStatus?.guildsCount || 0}</p>
              </div>
            </div>
          </div>

          {/* Navigation Tabs (Mobile-scrollable) */}
          <div className="px-3.5 sm:px-6 py-2 border-b border-white/5 flex items-center gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar shrink-0">
            <button
              onClick={() => setActiveTab('servers')}
              className={`px-3 py-1.5 sm:px-4 sm:py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'servers'
                  ? 'bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-500/20'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
              }`}
            >
              <Server className="w-3.5 h-3.5 shrink-0" />
              <span>Profiles ({servers.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('discord')}
              className={`px-3 py-1.5 sm:px-4 sm:py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'discord'
                  ? 'bg-indigo-500 text-white shadow-md shadow-indigo-500/20'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
              }`}
            >
              <Bot className="w-3.5 h-3.5 shrink-0" />
              <span>Discord Bot</span>
            </button>

            <button
              onClick={() => setActiveTab('add')}
              className={`px-3 py-1.5 sm:px-4 sm:py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'add'
                  ? 'bg-zinc-800 text-white'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-900'
              }`}
            >
              <Plus className="w-3.5 h-3.5 shrink-0" />
              <span>Add Server</span>
            </button>
          </div>

          {/* Feedback Alert */}
          {message && (
            <div
              className={`mx-3.5 sm:mx-6 mt-2.5 p-2.5 rounded-xl text-xs flex items-center justify-between shrink-0 ${
                message.type === 'success'
                  ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
                  : 'bg-rose-500/10 border border-rose-500/20 text-rose-300'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span className="truncate">{message.text}</span>
              </div>
              <button onClick={() => setMessage(null)} className="text-zinc-400 hover:text-white p-1">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Tab Content Body */}
          <div className="flex-1 overflow-y-auto p-3.5 sm:p-6 overflow-x-hidden">
            {activeTab === 'servers' && (
              <div className="space-y-3.5">
                {/* Search & Filter Bar */}
                <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 items-stretch sm:items-center justify-between">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      placeholder="Search server IP or name..."
                      className="w-full pl-9 pr-3 py-2 rounded-xl bg-zinc-900 border border-white/10 text-xs text-white placeholder-zinc-500 outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div className="flex items-center gap-1.5 self-start sm:self-auto">
                    <span className="text-[11px] text-zinc-400">Filter:</span>
                    <div className="flex items-center p-0.5 rounded-xl bg-zinc-900 border border-white/5 text-xs">
                      {(['all', 'web', 'discord'] as const).map(src => (
                        <button
                          key={src}
                          onClick={() => setFilterSource(src)}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-medium capitalize transition-all ${
                            filterSource === src ? 'bg-zinc-800 text-white font-bold' : 'text-zinc-400 hover:text-white'
                          }`}
                        >
                          {src}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Servers List */}
                {filteredServers.length === 0 ? (
                  <div className="p-8 text-center rounded-2xl bg-zinc-900/40 border border-white/5">
                    <Server className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
                    <p className="text-xs font-semibold text-zinc-300">No server profiles recorded</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5">
                      Servers added in the app or via Discord <code className="text-emerald-400">/configure</code> will appear here.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredServers.map(server => {
                      const isRevealed = revealedCookies[server.id];
                      const status = server.liveStatus || 'offline';
                      const isOnline = status === 'online';
                      const isStarting = status === 'starting';

                      return (
                        <div
                          key={server.id}
                          className="p-3.5 sm:p-4 rounded-2xl bg-zinc-900/70 border border-white/10 hover:border-emerald-500/30 transition-all flex flex-col gap-3 overflow-hidden"
                        >
                          {/* Top Info Header */}
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                              <span className="text-xs sm:text-sm font-bold text-white font-mono break-all">
                                {server.serverIp || server.name}
                              </span>
                              {server.serverPort && (
                                <span className="text-[11px] text-zinc-400 font-mono">
                                  :{server.serverPort}
                                </span>
                              )}

                              <span
                                className={`px-2 py-0.5 rounded-full text-[9px] font-bold font-mono border flex items-center gap-1 shrink-0 ${
                                  isOnline
                                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                    : isStarting
                                    ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                    : 'bg-zinc-800 text-zinc-400 border-white/5'
                                }`}
                              >
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${
                                    isOnline ? 'bg-emerald-400 animate-pulse' : isStarting ? 'bg-amber-400' : 'bg-zinc-500'
                                  }`}
                                />
                                {status.toUpperCase()}
                              </span>

                              <span
                                className={`px-1.5 py-0.5 rounded text-[9px] font-semibold flex items-center gap-1 shrink-0 ${
                                  server.source === 'discord'
                                    ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/20'
                                    : 'bg-zinc-800 text-zinc-300 border border-white/5'
                                }`}
                              >
                                {server.source === 'discord' ? (
                                  <>
                                    <Bot className="w-2.5 h-2.5 text-indigo-400" />
                                    <span>Discord</span>
                                  </>
                                ) : (
                                  <>
                                    <Globe className="w-2.5 h-2.5 text-blue-400" />
                                    <span>Web</span>
                                  </>
                                )}
                              </span>

                              {server.playersOnline !== undefined && isOnline && (
                                <span className="text-[10px] font-mono text-zinc-300 bg-zinc-800/80 px-1.5 py-0.5 rounded shrink-0">
                                  {server.playersOnline}/{server.maxPlayers || 20}p
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Credentials Inspection Box (Mobile-responsive stacking) */}
                          <div className="p-2.5 rounded-xl bg-zinc-950/80 border border-white/5 space-y-1.5 text-[11px] font-mono">
                            {/* ATERNOS_SESSION */}
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                              <span className="text-zinc-500 shrink-0 text-[10px]">SESSION:</span>
                              <div className="flex items-center justify-between sm:justify-end gap-1.5 min-w-0 w-full sm:w-auto">
                                <span className="text-zinc-300 truncate font-mono text-[11px] flex-1 sm:flex-none sm:max-w-[340px]">
                                  {server.sessionCookie
                                    ? isRevealed
                                      ? server.sessionCookie
                                      : `${server.sessionCookie.substring(0, 8)}••••••••${server.sessionCookie.slice(-6)}`
                                    : '<empty>'}
                                </span>
                                {server.sessionCookie && (
                                  <div className="flex items-center gap-1 shrink-0">
                                    <button
                                      onClick={() => toggleReveal(server.id)}
                                      className="p-1 text-zinc-400 hover:text-white cursor-pointer"
                                      title={isRevealed ? 'Hide' : 'Reveal'}
                                    >
                                      {isRevealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                    </button>
                                    <button
                                      onClick={() => handleCopy(server.sessionCookie, `${server.id}-sess`)}
                                      className="p-1 text-zinc-400 hover:text-emerald-400 cursor-pointer"
                                      title="Copy session cookie"
                                    >
                                      {copiedKey === `${server.id}-sess` ? (
                                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                                      ) : (
                                        <Copy className="w-3.5 h-3.5" />
                                      )}
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* ATERNOS_SERVER */}
                            {server.serverCookie && (
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 border-t border-white/5 pt-1.5">
                                <span className="text-zinc-500 shrink-0 text-[10px]">SERVER_ID:</span>
                                <div className="flex items-center justify-between sm:justify-end gap-1.5 min-w-0 w-full sm:w-auto">
                                  <span className="text-zinc-300 font-mono text-[11px] truncate">{server.serverCookie}</span>
                                  <button
                                    onClick={() => handleCopy(server.serverCookie, `${server.id}-srv`)}
                                    className="p-1 text-zinc-400 hover:text-emerald-400 cursor-pointer shrink-0"
                                    title="Copy server ID"
                                  >
                                    {copiedKey === `${server.id}-srv` ? (
                                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Control Buttons Bar (100% Mobile-Friendly Grid/Flex) */}
                          <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1 border-t border-white/5">
                            {/* Power Controls */}
                            <div className="flex items-center gap-1.5 flex-1 sm:flex-none">
                              <button
                                onClick={() => handleAction('start', server)}
                                disabled={isOnline || actionLoading === `${server.id}-start`}
                                title={isOnline ? 'Already online' : 'Start server'}
                                className={`flex-1 sm:flex-none px-3 py-1.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-all cursor-pointer ${
                                  isOnline
                                    ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed opacity-50'
                                    : 'bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-sm'
                                }`}
                              >
                                <Power className="w-3 h-3" />
                                <span>Start</span>
                              </button>

                              <button
                                onClick={() => handleAction('stop', server)}
                                disabled={!isOnline && status === 'offline' || actionLoading === `${server.id}-stop`}
                                title={!isOnline ? 'Already offline' : 'Stop server'}
                                className={`flex-1 sm:flex-none px-3 py-1.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-all cursor-pointer ${
                                  !isOnline && status === 'offline'
                                    ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed opacity-50'
                                    : 'bg-rose-500 hover:bg-rose-400 text-white shadow-sm'
                                }`}
                              >
                                <Power className="w-3 h-3" />
                                <span>Stop</span>
                              </button>

                              <button
                                onClick={() => handleAction('restart', server)}
                                disabled={actionLoading === `${server.id}-restart`}
                                className="p-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer shrink-0"
                                title="Restart server"
                              >
                                <RotateCw className="w-3.5 h-3.5" />
                              </button>
                            </div>

                            {/* View & Delete Controls */}
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={() => {
                                  onSelectServerToMonitor(server);
                                  onClose();
                                }}
                                className="px-2.5 py-1.5 rounded-xl bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 text-blue-400 hover:text-blue-300 text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                              >
                                <ExternalLink className="w-3 h-3" />
                                <span>Monitor in UI</span>
                              </button>

                              <button
                                onClick={() => handleDelete(server.id)}
                                className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 transition-colors cursor-pointer"
                                title="Delete profile"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Discord Bot Console Tab */}
            {activeTab === 'discord' && (
              <div className="space-y-4">
                <div className="p-4 sm:p-5 rounded-2xl bg-zinc-900/60 border border-indigo-500/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
                      <Bot className="w-5 h-5 sm:w-6 sm:h-6" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm sm:text-base font-bold text-white truncate">
                          {botStatus?.botTag || 'Aternos Bot'}
                        </h3>
                        <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shrink-0">
                          ONLINE
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-400">
                        Guilds: {botStatus?.guildsCount || 0} • Ping: {botStatus?.ping || 0}ms
                      </p>
                    </div>
                  </div>

                  <a
                    href="https://discord.com/oauth2/authorize?client_id=1555330856757755994&permissions=2147485696&scope=bot%20applications.commands"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full sm:w-auto px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Invite Bot to Server</span>
                  </a>
                </div>

                {/* Commands Reference */}
                <div className="p-3.5 sm:p-4 rounded-xl bg-zinc-900/40 border border-white/5 space-y-2">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                    <Terminal className="w-3 h-3 text-emerald-400" />
                    Bot Commands
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <div className="p-2.5 rounded-lg bg-zinc-950 border border-white/5">
                      <code className="text-emerald-400 font-bold">/configure</code>
                      <p className="text-zinc-400 text-[11px]">Link Aternos session and server ID.</p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-950 border border-white/5">
                      <code className="text-emerald-400 font-bold">/start</code>
                      <p className="text-zinc-400 text-[11px]">Turn server on (blocked if already online).</p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-950 border border-white/5">
                      <code className="text-emerald-400 font-bold">/stop</code>
                      <p className="text-zinc-400 text-[11px]">Turn server off (blocked if already offline).</p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-950 border border-white/5">
                      <code className="text-emerald-400 font-bold">/players</code>
                      <p className="text-zinc-400 text-[11px]">List online players with custom skin heads.</p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-950 border border-white/5">
                      <code className="text-emerald-400 font-bold">/status</code>
                      <p className="text-zinc-400 text-[11px]">Check server status, IP, port, and players.</p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-zinc-950 border border-white/5">
                      <code className="text-emerald-400 font-bold">/restart</code>
                      <p className="text-zinc-400 text-[11px]">Reboot server.</p>
                    </div>
                  </div>
                </div>

                {/* Discord Execution Logs */}
                <div className="space-y-1.5">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                    <Activity className="w-3 h-3 text-indigo-400" />
                    Recent Activity
                  </h4>
                  <div className="p-3 rounded-xl bg-zinc-950 border border-white/5 max-h-56 overflow-y-auto space-y-1.5 font-mono text-[11px]">
                    {botStatus?.recentLogs && botStatus.recentLogs.length > 0 ? (
                      botStatus.recentLogs.map((log: any) => (
                        <div key={log.id} className="flex items-start gap-2 py-0.5 border-b border-white/[0.03]">
                          <span className="text-zinc-500 shrink-0">[{log.timestamp}]</span>
                          <span className="text-indigo-400 shrink-0">@{log.user}:</span>
                          <span className="text-emerald-300 font-bold shrink-0">{log.command}</span>
                          <span className="text-zinc-400 truncate flex-1">{log.message}</span>
                        </div>
                      ))
                    ) : (
                      <div className="text-zinc-500 text-center py-4 text-xs">
                        No Discord commands executed yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Register New Server Tab */}
            {activeTab === 'add' && (
              <div className="max-w-md mx-auto py-2">
                <div className="p-4 sm:p-6 rounded-2xl bg-zinc-900/60 border border-white/10 space-y-4">
                  <div>
                    <h3 className="text-sm sm:text-base font-bold text-white">Register Server Profile</h3>
                    <p className="text-[11px] text-zinc-400">Manually save a server profile to the database</p>
                  </div>

                  <form onSubmit={handleCreateServer} className="space-y-3">
                    <div>
                      <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                        Minecraft Address
                      </label>
                      <input
                        type="text"
                        value={newServerAddress}
                        onChange={e => setNewServerAddress(e.target.value)}
                        placeholder="e.g. myserver.aternos.me"
                        required
                        className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 outline-none focus:border-emerald-500"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                        ATERNOS_SESSION Cookie
                      </label>
                      <input
                        type="text"
                        value={newSessionCookie}
                        onChange={e => setNewSessionCookie(e.target.value)}
                        placeholder="Paste full cookie string..."
                        required
                        className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 outline-none focus:border-emerald-500 font-mono"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-zinc-300 mb-1">
                        ATERNOS_SERVER Cookie / ID
                      </label>
                      <input
                        type="text"
                        value={newServerCookie}
                        onChange={e => setNewServerCookie(e.target.value)}
                        placeholder="e.g. ATobOAQ3Dq2guih..."
                        className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white placeholder-zinc-500 outline-none focus:border-emerald-500 font-mono"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] font-medium text-zinc-300 mb-1">Software</label>
                        <input
                          type="text"
                          value={newSoftware}
                          onChange={e => setNewSoftware(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white outline-none focus:border-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-zinc-300 mb-1">Version</label>
                        <input
                          type="text"
                          value={newVersion}
                          onChange={e => setNewVersion(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white outline-none focus:border-emerald-500"
                        />
                      </div>
                    </div>

                    <div className="pt-1">
                      <button
                        type="submit"
                        className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold text-xs shadow-md transition-all cursor-pointer"
                      >
                        Save Server Profile
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
