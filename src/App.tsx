import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import type { AternosState, LogEntry, ServerProfile, SessionConfig, MacroRule } from './types/aternos.ts';
import { TopBar } from './components/TopBar.tsx';
import { ServerSwitcher } from './components/ServerSwitcher.tsx';
import { ManageServersModal } from './components/ManageServersModal.tsx';
import { ServerCard } from './components/ServerCard.tsx';
import { AternosCountdownWidget } from './components/AternosCountdownWidget.tsx';
import { ActionControls } from './components/ActionControls.tsx';
import { MacroControlPanel, DEFAULT_PROFILE_MACROS } from './components/MacroControlPanel.tsx';
import { TerminalConsole } from './components/TerminalConsole.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import { MobileTouchBar } from './components/MobileTouchBar.tsx';
import { ToastContainer, type ToastMessage } from './components/Toast.tsx';
import { AdminLoginModal } from './components/AdminLoginModal.tsx';
import { AdminPanelModal } from './components/AdminPanelModal.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Key, Server, Plus, ShieldCheck, Timer, Zap, Sparkles } from 'lucide-react';

const MASTER_ADMIN_TOKEN = 'shifin-auth-session-key-0508552513';
const STORAGE_SERVERS_KEY = 'aternos_multi_servers';
const STORAGE_ACTIVE_ID_KEY = 'aternos_active_server_id';
const STORAGE_SERVER_STATES_KEY = 'aternos_multi_server_states';
const STORAGE_ADMIN_TOKEN_KEY = 'aternos_admin_token';
const STORAGE_ADMIN_USER_KEY = 'aternos_admin_user';

const INITIAL_STATE: AternosState = {
  status: 'offline',
  rawStatus: 'Offline',
  serverIp: '',
  serverPort: '',
  software: '',
  version: '',
  queuePosition: null,
  queueEta: null,
  countdownSeconds: null,
  countdownFormatted: null,
  countdownActive: false,
  canExtend: false,
  startVisible: false,
  stopVisible: false,
  restartVisible: false,
  extendVisible: false,
  lastUpdated: Date.now(),
  isActionPending: false,
  currentAction: null,
  sessionConnected: false,
  sessionError: null,
};

export default function App() {
  // 1. Multi-Server Profiles State
  const [servers, setServers] = useState<ServerProfile[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_SERVERS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {}
    return [];
  });

  const [activeServerId, setActiveServerId] = useState<string>(() => {
    try {
      const savedId = localStorage.getItem(STORAGE_ACTIVE_ID_KEY);
      if (savedId) return savedId;
    } catch {}
    return '';
  });

  // Admin authentication state
  const [isAdminLoginOpen, setIsAdminLoginOpen] = useState(false);
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState(false);
  const [adminToken, setAdminToken] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_ADMIN_TOKEN_KEY) || '';
    } catch {}
    return '';
  });
  const [adminUsername, setAdminUsername] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_ADMIN_USER_KEY) || '';
    } catch {}
    return '';
  });

  const activeServer: ServerProfile | null =
    servers.find(s => s.id === activeServerId) || servers[0] || null;

  // 2. Track real-time live states for server profiles
  const [serverStates, setServerStates] = useState<Record<string, AternosState>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_SERVER_STATES_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {}
    return {};
  });

  const [state, setState] = useState<AternosState>(() => {
    if (activeServer) {
      const cached = serverStates[activeServer.id] || serverStates[activeServer.serverIp.toLowerCase()];
      if (cached) return cached;
      return {
        ...INITIAL_STATE,
        serverIp: activeServer.serverIp,
        serverPort: activeServer.serverPort,
        software: activeServer.software,
        version: activeServer.version,
        sessionConnected: Boolean(activeServer.sessionCookie && activeServer.sessionCookie.trim()),
      };
    }
    return INITIAL_STATE;
  });

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isManageServersOpen, setIsManageServersOpen] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // Persist serverStates across reloads
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_SERVER_STATES_KEY, JSON.stringify(serverStates));
    } catch {}
  }, [serverStates]);

  const addToast = (type: 'info' | 'success' | 'warning' | 'error', message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
  };

  const dismissToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Restore persisted server profiles ONLY if admin is authenticated
  useEffect(() => {
    if (!adminToken) return;
    let isMounted = true;
    fetch('/api/user/profiles', {
      headers: { 'x-admin-token': adminToken },
    })
      .then(res => res.json())
      .then(data => {
        if (!isMounted) return;
        const remoteServers = data?.servers;
        if (Array.isArray(remoteServers) && remoteServers.length > 0) {
          setServers(prev => {
            const map = new Map<string, ServerProfile>();
            // Add existing state profiles
            for (const s of prev) {
              if (s && s.id) map.set(s.id, s);
            }
            // Add remote persistent profiles
            for (const s of remoteServers) {
              if (s && s.id) {
                const existing = map.get(s.id);
                map.set(s.id, {
                  ...existing,
                  ...s,
                  sessionCookie: (s.sessionCookie && !s.sessionCookie.includes('...')) ? s.sessionCookie : existing?.sessionCookie || '',
                });
              }
            }
            const merged = Array.from(map.values());
            if (merged.length > 0 && !activeServerId) {
              setActiveServerId(merged[0].id);
            }
            return merged;
          });
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [adminToken]);

  // Persist servers changes to user's localStorage (and backend if admin)
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_SERVERS_KEY, JSON.stringify(servers));
      if (adminToken && servers.length > 0) {
        fetch('/api/servers/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-token': adminToken,
          },
          body: JSON.stringify({ servers }),
        }).catch(() => {});
      }
    } catch {}
  }, [servers, adminToken]);

  // Persist active server ID
  useEffect(() => {
    try {
      if (activeServerId) {
        localStorage.setItem(STORAGE_ACTIVE_ID_KEY, activeServerId);
      } else {
        localStorage.removeItem(STORAGE_ACTIVE_ID_KEY);
      }
    } catch {}
  }, [activeServerId]);

  // Ensure activeServerId is valid when servers list changes
  useEffect(() => {
    if (servers.length === 0) {
      if (activeServerId) setActiveServerId('');
    } else if (!servers.some(s => s.id === activeServerId)) {
      setActiveServerId(servers[0].id);
    }
  }, [servers, activeServerId]);

  // Sync active server credentials with backend
  const syncServerWithBackend = useCallback(async (server: ServerProfile) => {
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionCookie: server.sessionCookie,
          serverCookie: server.serverCookie,
          serverAddress: server.serverIp,
          cfClearanceCookie: server.cfClearanceCookie,
          userAgent: server.userAgent,
          software: server.software,
          version: server.version,
          serverPort: server.serverPort,
        }),
      });
    } catch {}
  }, []);

  // Sync on initial mount & whenever active server changes
  useEffect(() => {
    if (!activeServer) return;

    syncServerWithBackend(activeServer);

    const existing = serverStates[activeServer.id] || serverStates[activeServer.serverIp.toLowerCase()];
    if (existing) {
      setState(existing);
    } else {
      setState(prev => ({
        ...prev,
        serverIp: activeServer.serverIp,
        serverPort: activeServer.serverPort,
        software: activeServer.software,
        version: activeServer.version,
        sessionConnected: Boolean(activeServer.sessionCookie && activeServer.sessionCookie.trim()),
      }));
    }
  }, [activeServer?.id, syncServerWithBackend]);

  // Poll Status & Logs every 2500ms when an active server exists
  useEffect(() => {
    if (!activeServer) return;

    let isMounted = true;

    const fetchSync = async () => {
      try {
        setIsSyncing(true);
        const [statusRes, logsRes] = await Promise.all([
          fetch(`/api/status?server=${encodeURIComponent(activeServer.serverIp || activeServer.id)}`),
          fetch('/api/logs'),
        ]);

        if (statusRes.ok && isMounted) {
          const statusData: AternosState = await statusRes.json();
          setState(prev => {
            if (statusData.status === 'offline' || statusData.status === 'stopping') {
              return {
                ...statusData,
                serverIp: activeServer.serverIp || statusData.serverIp,
                software: activeServer.software || statusData.software,
                version: activeServer.version || statusData.version,
                countdownActive: false,
                countdownSeconds: null,
                countdownFormatted: null,
                canExtend: false,
              };
            }
            return {
              ...statusData,
              serverIp: statusData.serverIp || activeServer.serverIp,
              software: statusData.software || activeServer.software,
              version: statusData.version || activeServer.version,
              countdownSeconds: statusData.countdownSeconds !== null ? statusData.countdownSeconds : null,
            };
          });

          // Update multi-server profile live states
          if (statusData.allServerStates) {
            setServerStates(prev => {
              const merged = { ...prev };
              for (const [k, s] of Object.entries(statusData.allServerStates as Record<string, AternosState>)) {
                merged[k.toLowerCase()] = s;
              }
              merged[activeServer.id] = { ...statusData };
              if (activeServer.serverIp) {
                merged[activeServer.serverIp.toLowerCase()] = { ...statusData };
              }
              return merged;
            });
          }
        }

        if (logsRes.ok && isMounted) {
          const logsData: LogEntry[] = await logsRes.json();
          setLogs(logsData);
        }
      } catch {
        // network retry
      } finally {
        if (isMounted) setIsSyncing(false);
      }
    };

    fetchSync();
    const interval = setInterval(fetchSync, 2500);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeServer?.id, activeServer?.serverIp]);

  // Local Countdown Ticker across active state and all profile states
  useEffect(() => {
    const ticker = setInterval(() => {
      setState(prev => {
        if (
          prev.status === 'online' &&
          prev.countdownActive &&
          prev.countdownSeconds !== null &&
          prev.countdownSeconds > 0
        ) {
          const nextSec = prev.countdownSeconds - 1;
          const mins = Math.floor(nextSec / 60);
          const secs = nextSec % 60;
          return {
            ...prev,
            countdownSeconds: nextSec,
            countdownFormatted: `${mins}:${secs < 10 ? '0' : ''}${secs}`,
            canExtend: nextSec <= 60,
          };
        }
        return prev;
      });

      setServerStates(prev => {
        let hasChanges = false;
        const next = { ...prev };
        for (const [key, s] of Object.entries(next)) {
          if (s.status === 'online' && s.countdownActive && s.countdownSeconds !== null && s.countdownSeconds > 0) {
            hasChanges = true;
            const nextSec = s.countdownSeconds - 1;
            const mins = Math.floor(nextSec / 60);
            const secs = nextSec % 60;
            next[key] = {
              ...s,
              countdownSeconds: nextSec,
              countdownFormatted: `${mins}:${secs < 10 ? '0' : ''}${secs}`,
              canExtend: nextSec <= 60,
            };
          }
        }
        return hasChanges ? next : prev;
      });
    }, 1000);

    return () => clearInterval(ticker);
  }, []);

  // Multi-Server Profile Handlers
  const handleSelectServer = (id: string) => {
    const target = servers.find(s => s.id === id);
    if (!target) return;

    if (activeServer) {
      setServerStates(prev => ({
        ...prev,
        [activeServer.id]: { ...state },
        [activeServer.serverIp.toLowerCase()]: { ...state },
      }));
    }

    setActiveServerId(id);

    const targetCached = serverStates[id] || serverStates[target.serverIp.toLowerCase()];
    if (targetCached) {
      setState(targetCached);
    } else {
      setState({
        ...INITIAL_STATE,
        serverIp: target.serverIp,
        serverPort: target.serverPort,
        software: target.software,
        version: target.version,
        sessionConnected: Boolean(target.sessionCookie && target.sessionCookie.trim()),
      });
    }

    addToast('info', `Switched view to ${target.name}.`);
  };

  const handleAddServer = (newServerData: Omit<ServerProfile, 'id'>) => {
    const newId = `server-${Date.now()}`;
    const newProfile: ServerProfile = {
      ...newServerData,
      id: newId,
      macros: JSON.parse(JSON.stringify(DEFAULT_PROFILE_MACROS)),
      lastActive: Date.now(),
    };
    setServers(prev => [...prev, newProfile]);
    setActiveServerId(newId);
    setIsManageServersOpen(false);
    addToast('success', `Server "${newProfile.name}" created and connected.`);
  };

  const handleUpdateServer = (id: string, updated: Partial<ServerProfile>) => {
    setServers(prev =>
      prev.map(s => (s.id === id ? { ...s, ...updated } : s))
    );
    if (activeServer && id === activeServer.id) {
      const merged = { ...activeServer, ...updated };
      syncServerWithBackend(merged);
    }
    addToast('info', 'Server profile updated.');
  };

  const handleUpdateServerMacros = (serverId: string, updatedMacros: MacroRule[]) => {
    setServers(prev =>
      prev.map(s => (s.id === serverId ? { ...s, macros: updatedMacros } : s))
    );
  };

  const handleDeleteServer = (id: string) => {
    const remaining = servers.filter(s => s.id !== id);
    setServers(remaining);
    if (activeServerId === id) {
      setActiveServerId(remaining[0]?.id || '');
    }
    addToast('info', 'Server profile removed.');
  };

  // Actions
  const handleStart = async () => {
    if (!activeServer) {
      addToast('warning', 'Please add a server profile first.');
      setIsManageServersOpen(true);
      return;
    }
    if (!activeServer.sessionCookie) {
      addToast('warning', 'Please enter your Aternos session cookie in Session Auth first.');
      setIsSettingsOpen(true);
      return;
    }
    if (state.status === 'starting' || state.status === 'loading') {
      addToast('info', 'Startup sequence in progress.');
      return;
    }

    setIsActionLoading(true);
    addToast('info', `Starting ${activeServer.name}...`);

    try {
      const res = await fetch('/api/action/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverAddress: activeServer.serverIp,
          sessionCookie: activeServer.sessionCookie,
          serverCookie: activeServer.serverCookie,
          serverId: activeServer.id,
        }),
      });
      const data = await res.json();
      if (data.success) {
        addToast('success', data.message || 'Server start sequence triggered.');
        const updated = await fetch(`/api/status?server=${encodeURIComponent(activeServer.serverIp || activeServer.id)}`).then(r => r.json());
        setState(updated);
        setServerStates(prev => ({
          ...prev,
          [activeServer.id]: updated,
          [activeServer.serverIp.toLowerCase()]: updated,
        }));
      } else {
        addToast('error', data.message || 'Failed to start server.');
      }
    } catch (err: any) {
      addToast('error', `Connection error: ${err.message}`);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleStop = async () => {
    if (!activeServer) return;
    if (!activeServer.sessionCookie) {
      addToast('warning', 'Session cookies required.');
      return;
    }
    if (state.status === 'offline') {
      addToast('warning', 'Server is already offline.');
      return;
    }

    setIsActionLoading(true);
    addToast('info', `Stopping ${activeServer.name}...`);

    try {
      const res = await fetch('/api/action/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverAddress: activeServer.serverIp,
          sessionCookie: activeServer.sessionCookie,
          serverCookie: activeServer.serverCookie,
          serverId: activeServer.id,
        }),
      });
      const data = await res.json();
      if (data.success) {
        addToast('success', data.message || 'Server shutdown initiated.');
        const updated = await fetch(`/api/status?server=${encodeURIComponent(activeServer.serverIp || activeServer.id)}`).then(r => r.json());
        setState(updated);
        setServerStates(prev => ({
          ...prev,
          [activeServer.id]: updated,
          [activeServer.serverIp.toLowerCase()]: updated,
        }));
      } else {
        addToast('error', data.message || 'Failed to stop server.');
      }
    } catch (err: any) {
      addToast('error', `Connection error: ${err.message}`);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRestart = async () => {
    if (!activeServer) return;
    if (!activeServer.sessionCookie) {
      addToast('warning', 'Session cookies required.');
      return;
    }
    if (state.status === 'offline') {
      addToast('warning', 'Cannot restart offline server. Please click Start Server.');
      return;
    }

    setIsActionLoading(true);
    addToast('info', `Rebooting ${activeServer.name}...`);

    try {
      const res = await fetch('/api/action/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverAddress: activeServer.serverIp,
          sessionCookie: activeServer.sessionCookie,
          serverCookie: activeServer.serverCookie,
          serverId: activeServer.id,
        }),
      });
      const data = await res.json();
      if (data.success) {
        addToast('success', data.message || 'Server restart cycle triggered.');
        const updated = await fetch(`/api/status?server=${encodeURIComponent(activeServer.serverIp || activeServer.id)}`).then(r => r.json());
        setState(updated);
        setServerStates(prev => ({
          ...prev,
          [activeServer.id]: updated,
          [activeServer.serverIp.toLowerCase()]: updated,
        }));
      } else {
        addToast('error', data.message || 'Failed to restart server.');
      }
    } catch (err: any) {
      addToast('error', `Connection error: ${err.message}`);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleExtend = async () => {
    if (!activeServer) return;
    if (state.status !== 'online') {
      addToast('warning', 'Keepalive timer is not available when server is inactive.');
      return;
    }

    if ((state.playersOnline ?? 0) > 0) {
      addToast(
        'info',
        `Keepalive timer is paused because ${state.playersOnline} player${state.playersOnline! > 1 ? 's are' : ' is'} online. The server stays online automatically!`
      );
      return;
    }

    // Aternos Dashboard Rule: Keepalive +1 minute is ONLY available when the countdown is at or below 1:00 (<= 60s)
    if (state.countdownSeconds !== null && state.countdownSeconds > 60) {
      const m = Math.floor(state.countdownSeconds / 60);
      const s = state.countdownSeconds % 60;
      const formatted = `${m}:${s < 10 ? '0' : ''}${s}`;
      addToast(
        'warning',
        `+1 isn't available on Aternos dashboard right now (${formatted} remaining). Aternos only allows extending when countdown drops below 1:00!`
      );
      return;
    }

    setIsActionLoading(true);
    addToast('info', 'Adding +1m keepalive...');

    try {
      const res = await fetch('/api/action/extend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverAddress: activeServer.serverIp,
          sessionCookie: activeServer.sessionCookie,
          serverCookie: activeServer.serverCookie,
          serverId: activeServer.id,
        }),
      });
      const data = await res.json();
      if (data.success) {
        addToast('success', '+1 Minute added to countdown timer!');
        const updated = await fetch(`/api/status?server=${encodeURIComponent(activeServer.serverIp || activeServer.id)}`).then(r => r.json());
        setState(updated);
        setServerStates(sPrev => ({
          ...sPrev,
          [activeServer.id]: updated,
          [activeServer.serverIp.toLowerCase()]: updated,
        }));
      } else {
        addToast('warning', data.message || 'Could not extend server timer.');
      }
    } catch (err: any) {
      addToast('error', `Connection error: ${err.message}`);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleClearLogs = async () => {
    try {
      await fetch('/api/logs', { method: 'DELETE' });
      setLogs([]);
      addToast('info', 'Console logs cleared.');
    } catch {}
  };

  const handleSaveConfig = async (newConfig: Partial<SessionConfig> & { name?: string }) => {
    if (!activeServer) return;

    const nextAddress = newConfig.serverAddress ? newConfig.serverAddress.trim() : activeServer.serverIp;
    const nextName = newConfig.name ? newConfig.name.trim() : (activeServer.name || nextAddress);
    const updated = {
      ...activeServer,
      name: nextName,
      sessionCookie: newConfig.sessionCookie ?? activeServer.sessionCookie,
      serverCookie: newConfig.serverCookie ?? activeServer.serverCookie,
      serverIp: nextAddress,
    };

    setServers(prev =>
      prev.map(s => (s.id === activeServerId ? updated : s))
    );

    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...newConfig,
        serverAddress: nextAddress,
      }),
    });

    if (res.ok) {
      addToast('success', 'Credentials saved and synchronized.');
    } else {
      addToast('error', 'Failed to update credentials.');
    }
  };

  const isCountdownVisible =
    state.status === 'online' &&
    state.countdownActive &&
    state.countdownSeconds !== null &&
    state.countdownSeconds > 0;

  const hasSessionConfigured = Boolean(activeServer?.sessionCookie && activeServer.sessionCookie.trim());

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans pb-24 md:pb-10 selection:bg-white/20 selection:text-white overflow-x-hidden">
      {/* Top Bar Navigation */}
      <TopBar
        onOpenManageServers={() => setIsManageServersOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onTriggerAdmin={() => setIsAdminLoginOpen(true)}
        isAdminLoggedIn={Boolean(adminToken)}
        onOpenAdminPanel={() => setIsAdminPanelOpen(true)}
        activeServerName={activeServer ? (activeServer.serverIp || activeServer.name) : 'No server connected'}
        totalServersCount={servers.length}
        sessionConnected={Boolean(activeServer?.sessionCookie && activeServer.sessionCookie.trim().length > 0)}
      />

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Multi-Server Switcher Bar */}
        <ServerSwitcher
          servers={servers}
          activeServerId={activeServerId}
          activeStatus={state.status}
          serverStates={serverStates}
          onSelectServer={handleSelectServer}
          onOpenManageServers={() => setIsManageServersOpen(true)}
          onQuickAddServer={() => setIsManageServersOpen(true)}
        />

        {/* Clean Onboarding Empty State when user has 0 configured profiles */}
        {servers.length === 0 ? (
          <div className="bg-zinc-900/60 border border-white/[0.08] rounded-3xl p-6 sm:p-10 shadow-xl backdrop-blur-xl text-center">
            <div className="max-w-lg mx-auto space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-zinc-800 to-zinc-900 border border-white/10 flex items-center justify-center mx-auto shadow-inner text-emerald-400">
                <Server className="w-8 h-8" />
              </div>

              <div>
                <span className="px-3 py-1 rounded-full text-xs font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 inline-flex items-center gap-1.5 mb-2">
                  <ShieldCheck className="w-3.5 h-3.5" /> Isolated Private Workspace
                </span>
                <h2 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight">
                  No Server Profiles Configured
                </h2>
                <p className="text-xs sm:text-sm text-zinc-400 mt-2 leading-relaxed">
                  Welcome to Aternos Command Center! Connect your Aternos Minecraft server to monitor real-time status, manage players, and automate 24/7 keepalive +1 timers.
                </p>
              </div>

              <div className="pt-2">
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.96 }}
                  onClick={() => setIsManageServersOpen(true)}
                  className="px-6 py-3 rounded-full text-sm font-mono font-bold text-black bg-white hover:bg-zinc-200 transition-all cursor-pointer shadow-lg inline-flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  <span>+ Add Your First Server Profile</span>
                </motion.button>
              </div>

              {/* 3-Step Setup Guide */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-left pt-6 border-t border-white/[0.06] mt-6">
                <div className="p-4 rounded-2xl bg-zinc-950/60 border border-white/[0.06] space-y-1">
                  <span className="text-[10px] font-mono font-bold text-emerald-400 uppercase tracking-wider block">
                    1. Domain
                  </span>
                  <div className="text-xs font-bold text-white">Server Address</div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    Enter your Aternos address (e.g. <span className="font-mono text-zinc-300">myserver.aternos.me</span>).
                  </p>
                </div>

                <div className="p-4 rounded-2xl bg-zinc-950/60 border border-white/[0.06] space-y-1">
                  <span className="text-[10px] font-mono font-bold text-emerald-400 uppercase tracking-wider block">
                    2. Security
                  </span>
                  <div className="text-xs font-bold text-white">Private Cookies</div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    Paste your <span className="font-mono text-zinc-300">ATERNOS_SESSION</span>. Kept safe in your browser.
                  </p>
                </div>

                <div className="p-4 rounded-2xl bg-zinc-950/60 border border-white/[0.06] space-y-1">
                  <span className="text-[10px] font-mono font-bold text-emerald-400 uppercase tracking-wider block">
                    3. Automation
                  </span>
                  <div className="text-xs font-bold text-white">Independent Macros</div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    Auto-click +1 timer when &lt; 1:00 and 24/7 crash recovery.
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Unconfigured Standby Prompt */}
            {!hasSessionConfigured && activeServer && (
              <div className="p-4 rounded-2xl bg-zinc-900 border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-3 text-zinc-300">
                  <Key className="w-4 h-4 text-zinc-400 shrink-0" />
                  <span>
                    No session cookies set for <strong className="text-white">{activeServer.name}</strong>. Add your Aternos session cookie in Session Auth to enable remote startup and keepalive.
                  </span>
                </div>
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="px-3.5 py-1.5 rounded-xl bg-white text-black font-bold hover:bg-zinc-200 transition-colors shrink-0 cursor-pointer self-start sm:self-auto font-mono"
                >
                  Configure Auth
                </button>
              </div>
            )}

            {/* Server Status Hero Card */}
            {activeServer && (
              <ServerCard
                state={state}
                serverName={activeServer.name}
                onCopyAddress={addr => addToast('success', `Copied address: ${addr}`)}
                onEditServer={() => setIsManageServersOpen(true)}
              />
            )}

            {/* Idle Countdown Widget (Online Only) */}
            {isCountdownVisible && (
              <div className="py-1 flex justify-center animate-in fade-in duration-300">
                <AternosCountdownWidget
                  serverStatus={state.status}
                  countdownActive={state.countdownActive}
                  countdownSeconds={state.countdownSeconds}
                  countdownFormatted={state.countdownFormatted}
                  playersOnline={state.playersOnline}
                  onExtend={handleExtend}
                  isExtending={isActionLoading}
                />
              </div>
            )}

            {/* Quick Action Control Panel */}
            <ActionControls
              state={state}
              onStart={handleStart}
              onStop={handleStop}
              onRestart={handleRestart}
              onExtend={handleExtend}
              isLoading={isActionLoading}
            />

            {/* Macro Automation Section with Per-Server Settings */}
            <MacroControlPanel
              server={activeServer}
              serverStatus={state.status}
              countdownSeconds={state.countdownSeconds}
              countdownFormatted={state.countdownFormatted}
              playersOnline={state.playersOnline}
              onRestart={handleRestart}
              onExtend={handleExtend}
              isActionLoading={isActionLoading}
              addToast={addToast}
              onUpdateServerMacros={handleUpdateServerMacros}
            />

            {/* Terminal Console */}
            <TerminalConsole
              logs={logs}
              onCopyNotice={() => addToast('info', 'Console logs copied to clipboard.')}
              onClearLogs={handleClearLogs}
            />
          </>
        )}
      </main>

      {/* Mobile Sticky Touch Bar (< md) */}
      {activeServer && (
        <MobileTouchBar
          state={state}
          onStart={handleStart}
          onStop={handleStop}
          onRestart={handleRestart}
          onExtend={handleExtend}
          isLoading={isActionLoading}
        />
      )}

      {/* Manage Servers Modal */}
      <ManageServersModal
        isOpen={isManageServersOpen}
        onClose={() => setIsManageServersOpen(false)}
        servers={servers}
        activeServerId={activeServerId}
        serverStates={serverStates}
        onSelectServer={handleSelectServer}
        onAddServer={handleAddServer}
        onUpdateServer={handleUpdateServer}
        onDeleteServer={handleDeleteServer}
      />

      {/* Session Settings Modal */}
      {activeServer && (
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          onSave={handleSaveConfig}
          currentConfig={{
            sessionCookie: activeServer.sessionCookie,
            serverCookie: activeServer.serverCookie,
            serverAddress: activeServer.serverIp,
            name: activeServer.name,
          }}
          serverName={activeServer.name}
        />
      )}

      {/* Admin Sign In Modal */}
      <AdminLoginModal
        isOpen={isAdminLoginOpen}
        onClose={() => setIsAdminLoginOpen(false)}
        onSuccess={(token, user) => {
          setAdminToken(token);
          setAdminUsername(user);
          try {
            localStorage.setItem(STORAGE_ADMIN_TOKEN_KEY, token);
            localStorage.setItem(STORAGE_ADMIN_USER_KEY, user);
          } catch {}
          setIsAdminPanelOpen(true);
          addToast('success', `Welcome ${user}! Admin Command Center unlocked.`);
        }}
      />

      {/* Admin Panel Modal wrapped in ErrorBoundary */}
      <ErrorBoundary fallbackTitle="Admin Panel Encountered an Issue" onReset={() => setIsAdminPanelOpen(false)}>
        <AdminPanelModal
          isOpen={isAdminPanelOpen}
          onClose={() => setIsAdminPanelOpen(false)}
          adminToken={adminToken}
          adminUsername={adminUsername}
          onSelectServerToMonitor={(selectedProfile) => {
            const existing = servers.find(s => s.id === selectedProfile.id || s.serverIp === selectedProfile.serverIp);
            if (existing) {
              setActiveServerId(existing.id);
            } else {
              const newProfile: ServerProfile = {
                id: selectedProfile.id,
                name: selectedProfile.name || selectedProfile.serverIp,
                serverIp: selectedProfile.serverIp,
                serverPort: selectedProfile.serverPort || '25565',
                software: selectedProfile.software || 'Paper / Bukkit',
                version: selectedProfile.version || '1.20.4',
                sessionCookie: selectedProfile.sessionCookie || '',
                serverCookie: selectedProfile.serverCookie || '',
              };
              setServers(prev => [newProfile, ...prev]);
              setActiveServerId(newProfile.id);
            }
            addToast('success', `Switched active monitor to ${selectedProfile.serverIp}`);
          }}
          onLogout={() => {
            setAdminToken('');
            try {
              localStorage.removeItem(STORAGE_ADMIN_TOKEN_KEY);
            } catch {}
            setIsAdminPanelOpen(false);
            addToast('info', 'Logged out of Admin Mode');
          }}
        />
      </ErrorBoundary>

      {/* Card-Stack Toast Container */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
