import React, { useState, useEffect, useCallback } from 'react';
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
  Lock,
  Radio,
} from 'lucide-react';
import type { ServerProfile } from '../types/aternos.ts';

const MASTER_ADMIN_TOKEN = 'shifin-auth-session-key-0508552513';

interface AdminPanelModalProps {
  isOpen: boolean;
  onClose: () => void;
  adminToken?: string;
  adminUsername?: string;
  onSelectServerToMonitor: (server: ServerProfile) => void;
  onLogout: () => void;
}

export const AdminPanelModal: React.FC<AdminPanelModalProps> = ({
  isOpen,
  onClose,
  adminToken,
  adminUsername = 'Admin',
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
  const [isSwitchingBot, setIsSwitchingBot] = useState(false);

  // Quick unlock password state if unauthorized
  const [isAuthLocked, setIsAuthLocked] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);

  // New server form state
  const [newServerAddress, setNewServerAddress] = useState('');
  const [newSessionCookie, setNewSessionCookie] = useState('');
  const [newServerCookie, setNewServerCookie] = useState('');
  const [newSoftware, setNewSoftware] = useState('Paper / Bukkit');
  const [newVersion, setNewVersion] = useState('1.20.4');

  const getEffectiveToken = useCallback(() => {
    return adminToken || localStorage.getItem('aternos_admin_token') || MASTER_ADMIN_TOKEN;
  }, [adminToken]);

  const fetchAdminData = useCallback(async () => {
    const token = getEffectiveToken();
    setIsLoading(true);
    setIsAuthLocked(false);
    try {
      const sRes = await fetch('/api/admin/servers', {
        headers: { 'x-admin-token': token },
      });

      if (sRes.status === 401 || sRes.status === 403) {
        setIsAuthLocked(true);
        return;
      }

      if (sRes.ok) {
        const sData = await sRes.json();
        if (sData?.success && Array.isArray(sData.servers)) {
          setServers(sData.servers);
        }
      }

      const bRes = await fetch('/api/admin/bot-status', {
        headers: { 'x-admin-token': token },
      });
      if (bRes.ok) {
        const bData = await bRes.json();
        if (bData && typeof bData === 'object') {
          setBotStatus(bData);
        }
      }
    } catch (err: any) {
      console.warn('Failed to load admin data:', err?.message);
    } finally {
      setIsLoading(false);
    }
  }, [getEffectiveToken]);

  useEffect(() => {
    if (isOpen) {
      fetchAdminData();
      const interval = setInterval(fetchAdminData, 8000);
      return () => clearInterval(interval);
    }
  }, [isOpen, fetchAdminData]);

  if (!isOpen) return null;

  const handleCopy = (text: string, key: string) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {}
  };

  const toggleReveal = (id: string) => {
    setRevealedCookies(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setUnlockError(null);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Shifin',
          password: unlockPassword.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        localStorage.setItem('aternos_admin_token', data.token);
        setIsAuthLocked(false);
        setUnlockPassword('');
        fetchAdminData();
      } else {
        setUnlockError(data.message || 'Incorrect password.');
      }
    } catch (err: any) {
      setUnlockError(err?.message || 'Authentication failed.');
    }
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
          'x-admin-token': getEffectiveToken(),
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
        setMessage({ type: 'success', text: `Action [${action.toUpperCase()}] executed for ${server.serverIp || server.name}` });
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
    try {
      const res = await fetch(`/api/admin/servers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': getEffectiveToken() },
      });
      if (res.ok) {
        setServers(prev => prev.filter(s => s.id !== id));
        setMessage({ type: 'success', text: 'Server profile removed from master database.' });
      }
    } catch {}
  };

  const handleCreateServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newServerAddress.trim() || !newSessionCookie.trim()) {
      setMessage({ type: 'error', text: 'Server address and Session Cookie are required.' });
      return;
    }

    try {
      const res = await fetch('/api/admin/servers/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': getEffectiveToken(),
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

  const handleSwitchBotTarget = async (target: 'dev' | 'published') => {
    setIsSwitchingBot(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/bot-mode', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': getEffectiveToken(),
        },
        body: JSON.stringify({ target }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: data.message || `Switched bot target to ${target.toUpperCase()}` });
        fetchAdminData();
      } else {
        setMessage({ type: 'error', text: data.message || 'Failed to switch bot target' });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Network error' });
    } finally {
      setIsSwitchingBot(false);
    }
  };

  const filteredServers = (Array.isArray(servers) ? servers : []).filter(s => {
    if (!s) return false;
    const sIp = String(s.serverIp || s.name || '').toLowerCase();
    const sUser = String(s.discordUser || '').toLowerCase();
    const query = (searchQuery || '').toLowerCase();
    const matchesSearch = sIp.includes(query) || sUser.includes(query);

    const matchesSource =
      filterSource === 'all' ||
      (filterSource === 'web' && s.source !== 'discord') ||
      (filterSource === 'discord' && s.source === 'discord');

    return matchesSearch && matchesSource;
  });

  const onlineServersCount = (Array.isArray(servers) ? servers : []).filter(s => s && s.liveStatus === 'online').length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/80 backdrop-blur-md"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative w-full max-w-5xl h-[88vh] min-h-[500px] max-h-[850px] bg-zinc-900 border border-emerald-500/40 rounded-2xl sm:rounded-3xl flex flex-col shadow-2xl shadow-emerald-950/40 overflow-hidden text-zinc-100"
        onClick={e => e.stopPropagation()}
      >
        {/* Top Header Bar */}
        <div className="px-4 sm:px-6 py-3.5 border-b border-white/10 bg-zinc-950/70 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl sm:rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
              <Shield className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm sm:text-base font-bold text-white tracking-tight truncate">
                  Apexion Admin Command Center
                </h2>
                <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 rounded-md border border-emerald-500/40 shrink-0">
                  ROOT ACCESS
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 truncate hidden sm:block">
                Apexion master servers database & multi-instance Discord bot control
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={fetchAdminData}
              disabled={isLoading}
              className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer"
              title="Refresh database"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-emerald-400' : ''}`} />
            </button>
            <button
              onClick={onLogout}
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 text-rose-400 text-xs font-semibold transition-colors cursor-pointer"
              title="Sign out of admin"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Logout</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Global Bot Active Host Quick Switcher Bar */}
        <div className="px-4 sm:px-6 py-2.5 bg-zinc-950/90 border-b border-white/5 flex flex-wrap items-center justify-between gap-2.5 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Radio className="w-3.5 h-3.5 text-indigo-400 shrink-0 animate-pulse" />
            <span className="text-xs font-bold text-white uppercase tracking-wider">Discord Bot Host:</span>
            <span className="text-xs font-mono font-bold text-emerald-400 bg-emerald-500/15 px-2 py-0.5 rounded border border-emerald-500/30">
              {botStatus?.activeTarget === 'published' ? '🚀 PUBLISHED CLOUD' : '🛠️ DEV SERVER'}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleSwitchBotTarget('dev')}
              disabled={isSwitchingBot}
              className={`px-3 py-1 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                botStatus?.activeTarget === 'dev'
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white'
              }`}
            >
              <span>🛠️ Dev Bot</span>
              {botStatus?.activeTarget === 'dev' && <Check className="w-3 h-3 text-emerald-300" />}
            </button>

            <button
              type="button"
              onClick={() => handleSwitchBotTarget('published')}
              disabled={isSwitchingBot}
              className={`px-3 py-1 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer flex items-center gap-1.5 ${
                botStatus?.activeTarget === 'published'
                  ? 'bg-emerald-600 text-white shadow-md'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white'
              }`}
            >
              <span>🚀 Published Bot</span>
              {botStatus?.activeTarget === 'published' && <Check className="w-3 h-3 text-emerald-300" />}
            </button>
          </div>
        </div>

        {/* Metrics Overview Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-4 sm:px-6 py-2.5 bg-zinc-900/50 border-b border-white/5 shrink-0">
          <div className="p-2 sm:p-2.5 rounded-xl bg-zinc-950/60 border border-white/5 flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
              <Server className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] text-zinc-400 uppercase font-semibold block leading-tight">Total Profiles</span>
              <p className="text-sm sm:text-base font-bold text-white leading-tight">{servers.length}</p>
            </div>
          </div>

          <div className="p-2 sm:p-2.5 rounded-xl bg-zinc-950/60 border border-white/5 flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
              <Activity className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] text-zinc-400 uppercase font-semibold block leading-tight">Live Online</span>
              <p className="text-sm sm:text-base font-bold text-emerald-400 leading-tight">{onlineServersCount}</p>
            </div>
          </div>

          <div className="p-2 sm:p-2.5 rounded-xl bg-zinc-950/60 border border-white/5 flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 shrink-0">
              <Bot className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] text-zinc-400 uppercase font-semibold block leading-tight">Discord Bot</span>
              <p className="text-xs font-bold text-white truncate leading-tight flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${botStatus?.isReady ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                <span className="truncate">{botStatus?.botTag || 'Apexion Bot'}</span>
              </p>
            </div>
          </div>

          <div className="p-2 sm:p-2.5 rounded-xl bg-zinc-950/60 border border-white/5 flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
              <Users className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] text-zinc-400 uppercase font-semibold block leading-tight">Connected Guilds</span>
              <p className="text-sm sm:text-base font-bold text-white leading-tight">{botStatus?.guildsCount || 0}</p>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="px-4 sm:px-6 py-2 border-b border-white/5 flex items-center gap-2 overflow-x-auto no-scrollbar shrink-0 bg-zinc-900/80">
          <button
            onClick={() => setActiveTab('servers')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'servers'
                ? 'bg-emerald-500 text-zinc-950 shadow-md font-extrabold'
                : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
            }`}
          >
            <Server className="w-3.5 h-3.5" />
            <span>Master Profiles ({servers.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('discord')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'discord'
                ? 'bg-indigo-600 text-white shadow-md font-extrabold'
                : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            <span>Discord Bot Switcher</span>
          </button>

          <button
            onClick={() => setActiveTab('add')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'add'
                ? 'bg-zinc-800 text-white'
                : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Server Profile</span>
          </button>
        </div>

        {/* Feedback Alert */}
        {message && (
          <div
            className={`mx-4 sm:mx-6 mt-3 p-3 rounded-xl text-xs flex items-center justify-between shrink-0 ${
              message.type === 'success'
                ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
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

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 overflow-x-hidden">
          {/* Quick Password Unlock Prompt if token is missing/expired */}
          {isAuthLocked ? (
            <div className="max-w-md mx-auto py-8 text-center space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center mx-auto">
                <Lock className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Admin Authentication Required</h3>
                <p className="text-xs text-zinc-400 mt-1">
                  Enter your admin password to view master profiles and bot controls.
                </p>
              </div>

              {unlockError && (
                <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
                  {unlockError}
                </div>
              )}

              <form onSubmit={handleUnlock} className="space-y-3">
                <input
                  type="password"
                  value={unlockPassword}
                  onChange={e => setUnlockPassword(e.target.value)}
                  placeholder="Admin password (0508552513)"
                  autoFocus
                  required
                  className="w-full px-4 py-2.5 rounded-xl bg-zinc-950 border border-zinc-700 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500 font-mono text-center"
                />
                <button
                  type="submit"
                  className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold text-xs shadow-md transition-all cursor-pointer"
                >
                  Unlock Admin Panel
                </button>
              </form>
            </div>
          ) : isLoading && servers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 gap-3">
              <RefreshCw className="w-8 h-8 text-emerald-400 animate-spin" />
              <p className="text-sm font-semibold text-zinc-300">Loading Master Server Database...</p>
              <p className="text-xs text-zinc-500">Connecting to secure endpoints...</p>
            </div>
          ) : activeTab === 'servers' ? (
            <div className="space-y-4">
              {/* Search & Filter Bar */}
              <div className="flex flex-col sm:flex-row gap-2.5 sm:gap-3 items-stretch sm:items-center justify-between">
                <div className="relative flex-1">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search by server IP or user..."
                    className="w-full pl-10 pr-3 py-2 rounded-xl bg-zinc-950 border border-white/10 text-xs text-white placeholder-zinc-500 outline-none focus:border-emerald-500"
                  />
                </div>

                <div className="flex items-center gap-1.5 self-start sm:self-auto">
                  <span className="text-[11px] text-zinc-400">Filter:</span>
                  <div className="flex items-center p-0.5 rounded-xl bg-zinc-950 border border-white/10 text-xs">
                    {(['all', 'web', 'discord'] as const).map(src => (
                      <button
                        key={src}
                        onClick={() => setFilterSource(src)}
                        className={`px-3 py-1 rounded-lg text-[11px] font-medium capitalize transition-all ${
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
                <div className="p-8 text-center rounded-2xl bg-zinc-950/60 border border-white/5">
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
                    const status = String(server.liveStatus || 'offline');
                    const isOnline = status === 'online';
                    const isStarting = status === 'starting';

                    return (
                      <div
                        key={server.id}
                        className="p-4 rounded-2xl bg-zinc-950/80 border border-white/10 hover:border-emerald-500/40 transition-all flex flex-col gap-3 overflow-hidden"
                      >
                        {/* Header Details */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            <span className="text-sm font-bold text-white font-mono break-all">
                              {server.serverIp || server.name}
                            </span>
                            {server.serverPort && (
                              <span className="text-xs text-zinc-400 font-mono">
                                :{server.serverPort}
                              </span>
                            )}

                            <span
                              className={`px-2 py-0.5 rounded-full text-[9px] font-bold font-mono border flex items-center gap-1 shrink-0 ${
                                isOnline
                                  ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                  : isStarting
                                  ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
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
                              className={`px-2 py-0.5 rounded text-[9px] font-semibold flex items-center gap-1 shrink-0 ${
                                server.source === 'discord'
                                  ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/20'
                                  : 'bg-zinc-800 text-zinc-300 border border-white/5'
                              }`}
                            >
                              {server.source === 'discord' ? (
                                <>
                                  <Bot className="w-2.5 h-2.5 text-indigo-400" />
                                  <span>Discord ({server.discordUser || 'Bot'})</span>
                                </>
                              ) : (
                                <>
                                  <Globe className="w-2.5 h-2.5 text-blue-400" />
                                  <span>Web Client</span>
                                </>
                              )}
                            </span>

                            {server.playersOnline !== undefined && isOnline && (
                              <span className="text-[10px] font-mono text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded shrink-0">
                                {server.playersOnline}/{server.maxPlayers || 20} players
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Credentials Inspection Box */}
                        <div className="p-3 rounded-xl bg-zinc-900 border border-white/5 space-y-2 text-[11px] font-mono">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                            <span className="text-zinc-400 shrink-0 text-[10px] font-bold">SESSION COOKIE:</span>
                            <div className="flex items-center justify-between sm:justify-end gap-2 min-w-0 w-full sm:w-auto">
                              <span className="text-zinc-200 truncate font-mono text-[11px] flex-1 sm:flex-none sm:max-w-[380px]">
                                {server.sessionCookie
                                  ? isRevealed
                                    ? String(server.sessionCookie)
                                    : `${String(server.sessionCookie).substring(0, 8)}••••••••${String(server.sessionCookie).slice(-6)}`
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
                                    onClick={() => handleCopy(String(server.sessionCookie), `${server.id}-sess`)}
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

                          {server.serverCookie && (
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 border-t border-white/5 pt-1.5">
                              <span className="text-zinc-400 shrink-0 text-[10px] font-bold">SERVER_ID COOKIE:</span>
                              <div className="flex items-center justify-between sm:justify-end gap-2 min-w-0 w-full sm:w-auto">
                                <span className="text-zinc-200 font-mono text-[11px] truncate">
                                  {String(server.serverCookie)}
                                </span>
                                <button
                                  onClick={() => handleCopy(String(server.serverCookie), `${server.id}-srv`)}
                                  className="p-1 text-zinc-400 hover:text-emerald-400 cursor-pointer shrink-0"
                                  title="Copy server cookie"
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

                        {/* Power Action Buttons */}
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-white/5">
                          <div className="flex items-center gap-2 flex-1 sm:flex-none">
                            <button
                              onClick={() => handleAction('start', server)}
                              disabled={isOnline || actionLoading === `${server.id}-start`}
                              className={`flex-1 sm:flex-none px-3.5 py-1.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                                isOnline
                                  ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed opacity-50'
                                  : 'bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-sm'
                              }`}
                            >
                              <Power className="w-3.5 h-3.5" />
                              <span>Start</span>
                            </button>

                            <button
                              onClick={() => handleAction('stop', server)}
                              disabled={(!isOnline && status === 'offline') || actionLoading === `${server.id}-stop`}
                              className={`flex-1 sm:flex-none px-3.5 py-1.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                                !isOnline && status === 'offline'
                                  ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed opacity-50'
                                  : 'bg-rose-500 hover:bg-rose-400 text-white shadow-sm'
                              }`}
                            >
                              <Power className="w-3.5 h-3.5" />
                              <span>Stop</span>
                            </button>

                            <button
                              onClick={() => handleAction('restart', server)}
                              disabled={actionLoading === `${server.id}-restart`}
                              className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                              title="Restart server"
                            >
                              <RotateCw className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={() => {
                                onSelectServerToMonitor(server);
                                onClose();
                              }}
                              className="px-3 py-1.5 rounded-xl bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 text-blue-400 hover:text-blue-300 text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span>Monitor in UI</span>
                            </button>

                            <button
                              onClick={() => handleDelete(server.id)}
                              className="p-2 rounded-xl text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
                              title="Delete profile"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : activeTab === 'discord' ? (
            /* Discord Bot Switcher Tab */
            <div className="space-y-4">
              <div className="p-4 sm:p-5 rounded-2xl bg-zinc-950/80 border border-indigo-500/30 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                      <Bot className="w-4 h-4 text-indigo-400" />
                      Active Discord Bot Host Switcher
                    </h4>
                    <p className="text-xs text-zinc-400 mt-1">
                      Choose which server connects to Discord Gateway. Turning one on turns the other off to prevent duplicate collisions.
                    </p>
                  </div>
                  <span className="text-xs font-mono font-bold text-indigo-300 bg-indigo-500/15 px-3 py-1 rounded-lg border border-indigo-500/30 self-start sm:self-auto">
                    Active: {botStatus?.activeTarget === 'published' ? '🚀 Published' : '🛠️ Dev Server'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Dev Option */}
                  <button
                    type="button"
                    onClick={() => handleSwitchBotTarget('dev')}
                    disabled={isSwitchingBot}
                    className={`p-4 rounded-xl border flex flex-col gap-2 text-left transition-all cursor-pointer ${
                      botStatus?.activeTarget === 'dev'
                        ? 'bg-indigo-600/20 border-indigo-500 text-white ring-2 ring-indigo-500/50'
                        : 'bg-zinc-900 border-white/10 hover:border-white/20 text-zinc-400'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold flex items-center gap-1.5 text-white">
                        🛠️ Dev Server Bot
                      </span>
                      {botStatus?.activeTarget === 'dev' ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                          ACTIVE (ON)
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono text-zinc-500 bg-zinc-800">
                          STANDBY (OFF)
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-zinc-400">
                      Connects Discord bot from the AI Studio development environment.
                    </span>
                  </button>

                  {/* Published Option */}
                  <button
                    type="button"
                    onClick={() => handleSwitchBotTarget('published')}
                    disabled={isSwitchingBot}
                    className={`p-4 rounded-xl border flex flex-col gap-2 text-left transition-all cursor-pointer ${
                      botStatus?.activeTarget === 'published'
                        ? 'bg-emerald-600/20 border-emerald-500 text-white ring-2 ring-emerald-500/50'
                        : 'bg-zinc-900 border-white/10 hover:border-white/20 text-zinc-400'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold flex items-center gap-1.5 text-white">
                        🚀 Published Cloud Bot
                      </span>
                      {botStatus?.activeTarget === 'published' ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                          ACTIVE (ON)
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono text-zinc-500 bg-zinc-800">
                          STANDBY (OFF)
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-zinc-400">
                      Connects Discord bot from your live published website (Cloud Run).
                    </span>
                  </button>
                </div>
              </div>

              {/* Bot Info Details */}
              <div className="p-4 rounded-2xl bg-zinc-950/70 border border-white/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
                    <Bot className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">
                      {botStatus?.botTag || 'Apexion Bot'}
                    </h3>
                    <p className="text-xs text-zinc-400">
                      Guilds: {botStatus?.guildsCount || 0} • Ping: {botStatus?.ping || 0}ms • Current Target:{' '}
                      <span className="text-emerald-400 font-bold">{String(botStatus?.activeTarget || 'published').toUpperCase()}</span>
                    </p>
                  </div>
                </div>

                <a
                  href="https://discord.com/oauth2/authorize?client_id=1555330856757755994&permissions=2147485696&scope=bot%20applications.commands"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Invite Bot to Discord Server</span>
                </a>
              </div>

              {/* Commands Reference */}
              <div className="p-4 rounded-xl bg-zinc-950/60 border border-white/5 space-y-2">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                  Available Slash Commands
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-white/5">
                    <code className="text-emerald-400 font-bold">/status</code>
                    <p className="text-zinc-400 text-[11px]">Check real-time server status, IP, port, and players.</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-white/5">
                    <code className="text-emerald-400 font-bold">/players</code>
                    <p className="text-zinc-400 text-[11px]">List connected players with online indicators.</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-white/5">
                    <code className="text-emerald-400 font-bold">/start</code>
                    <p className="text-zinc-400 text-[11px]">Turn server on (blocked if already online).</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-white/5">
                    <code className="text-emerald-400 font-bold">/stop</code>
                    <p className="text-zinc-400 text-[11px]">Turn server off safely.</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-white/5">
                    <code className="text-emerald-400 font-bold">/restart</code>
                    <p className="text-zinc-400 text-[11px]">Reboot server.</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-white/5">
                    <code className="text-emerald-400 font-bold">/configure</code>
                    <p className="text-zinc-400 text-[11px]">Bind Aternos session to your Discord server.</p>
                  </div>
                </div>
              </div>

              {/* Activity Logs */}
              <div className="space-y-2">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-indigo-400" />
                  Recent Discord Interactions
                </h4>
                <div className="p-3 rounded-xl bg-zinc-950 border border-white/5 max-h-56 overflow-y-auto space-y-1.5 font-mono text-[11px]">
                  {botStatus?.recentLogs && botStatus.recentLogs.length > 0 ? (
                    botStatus.recentLogs.map((log: any) => (
                      <div key={log.id} className="flex items-start gap-2 py-0.5 border-b border-white/[0.03]">
                        <span className="text-zinc-500 shrink-0">[{log.timestamp}]</span>
                        <span className="text-indigo-400 shrink-0">@{String(log.user || 'User')}:</span>
                        <span className="text-emerald-300 font-bold shrink-0">{String(log.command || '')}</span>
                        <span className="text-zinc-300 truncate flex-1">
                          {typeof log.message === 'object' ? JSON.stringify(log.message) : String(log.message || '')}
                        </span>
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
          ) : (
            /* Add Server Tab */
            <div className="max-w-md mx-auto py-2">
              <div className="p-5 sm:p-6 rounded-2xl bg-zinc-950/70 border border-white/10 space-y-4">
                <div>
                  <h3 className="text-sm sm:text-base font-bold text-white">Register Server Profile</h3>
                  <p className="text-[11px] text-zinc-400">Manually store a server profile in the master database</p>
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
                      className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-white placeholder-zinc-500 outline-none focus:border-emerald-500"
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
                      className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-white placeholder-zinc-500 outline-none focus:border-emerald-500 font-mono"
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
                      className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-white placeholder-zinc-500 outline-none focus:border-emerald-500 font-mono"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] font-medium text-zinc-300 mb-1">Software</label>
                      <input
                        type="text"
                        value={newSoftware}
                        onChange={e => setNewSoftware(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-white outline-none focus:border-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-zinc-300 mb-1">Version</label>
                      <input
                        type="text"
                        value={newVersion}
                        onChange={e => setNewVersion(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-white outline-none focus:border-emerald-500"
                      />
                    </div>
                  </div>

                  <div className="pt-2">
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
      </div>
    </div>
  );
};
