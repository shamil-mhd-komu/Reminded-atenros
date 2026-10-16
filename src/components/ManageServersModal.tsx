import React, { useState, useEffect } from 'react';
import {
  X,
  Server,
  Plus,
  Trash2,
  Edit2,
  Loader2,
  Check,
  Sparkles,
  Users,
  Wifi,
  Globe,
  Key,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import type { ServerProfile, AternosState } from '../types/aternos.ts';

interface ManageServersModalProps {
  isOpen: boolean;
  onClose: () => void;
  servers: ServerProfile[];
  activeServerId: string;
  serverStates?: Record<string, AternosState>;
  onSelectServer: (id: string) => void;
  onAddServer: (newServer: Omit<ServerProfile, 'id'>) => void;
  onUpdateServer: (id: string, updated: Partial<ServerProfile>) => void;
  onDeleteServer: (id: string) => void;
}

const SOFTWARE_OPTIONS = [
  'Paper / Bukkit',
  'Fabric',
  'Purpur',
  'Spigot',
  'Vanilla',
  'Forge',
  'NeoForge',
  'Bedrock (Geyser)',
];

export const ManageServersModal: React.FC<ManageServersModalProps> = ({
  isOpen,
  onClose,
  servers,
  activeServerId,
  serverStates = {},
  onSelectServer,
  onAddServer,
  onUpdateServer,
  onDeleteServer,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);

  // Form states
  const [displayName, setDisplayName] = useState('');
  const [serverAddress, setServerAddress] = useState('');
  const [serverPort, setServerPort] = useState('25565');
  const [software, setSoftware] = useState('Fabric');
  const [version, setVersion] = useState('1.20.4');
  const [sessionCookie, setSessionCookie] = useState('');
  const [serverCookie, setServerCookie] = useState('');
  const [cfClearanceCookie, setCfClearanceCookie] = useState('');

  const [isDetecting, setIsDetecting] = useState(false);
  const [detectedSuccess, setDetectedSuccess] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [discoveredServers, setDiscoveredServers] = useState<
    Array<{ id: string; name: string; serverAddress: string; serverCookie: string }>
  >([]);

  useEffect(() => {
    if (isOpen && servers.length === 0 && !isAddingNew && !editingId) {
      setIsAddingNew(true);
      setDisplayName('My Aternos Server');
      setServerAddress('');
      setSessionCookie('');
      setServerCookie('');
    }
  }, [isOpen, servers.length, isAddingNew, editingId]);

  if (!isOpen) return null;

  const startEdit = (server: ServerProfile) => {
    const key = (server.serverIp || server.name || server.id).toLowerCase();
    const live = serverStates[server.id] || serverStates[key];

    const effPort = live?.serverPort || server.serverPort || '25565';
    const effSoftware = live?.software || server.software || 'Paper / Bukkit';
    const effVersion = live?.version || server.version || '1.20.4';

    setEditingId(server.id);
    setIsAddingNew(false);
    setDisplayName(server.name || server.serverIp || '');
    setServerAddress(server.serverIp || server.name || '');
    setServerPort(effPort);
    setSoftware(effSoftware);
    setVersion(effVersion);
    setSessionCookie(server.sessionCookie || '');
    setServerCookie(server.serverCookie || '');
    setCfClearanceCookie(server.cfClearanceCookie || '');
    setDetectedSuccess(false);
    setDetectError(null);
    setDiscoveredServers([]);
  };

  const startCreate = () => {
    setEditingId(null);
    setIsAddingNew(true);
    setDisplayName('');
    setServerAddress('');
    setServerPort('25565');
    setSoftware('Fabric');
    setVersion('1.20.4');
    setSessionCookie('');
    setServerCookie('');
    setCfClearanceCookie('');
    setDetectedSuccess(false);
    setDetectError(null);
    setDiscoveredServers([]);
  };

  const handleAutoDetect = async (sessionVal = sessionCookie, serverVal = serverCookie) => {
    let cleanSession = sessionVal.trim();
    let cleanServer = serverVal.trim();

    // If session cookie is empty in form, look up from existing profiles
    if (!cleanSession) {
      const existingWithSession = servers.find(
        s => s.sessionCookie && s.sessionCookie.trim().length > 10 && !s.sessionCookie.includes('...')
      );
      if (existingWithSession) {
        cleanSession = existingWithSession.sessionCookie.trim();
        setSessionCookie(cleanSession);
      }
    }

    if (!cleanSession) {
      setDetectError('Please paste your ATERNOS_SESSION cookie first.');
      return;
    }

    setIsDetecting(true);
    setDetectError(null);
    try {
      const res = await fetch('/api/server/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionCookie: cleanSession,
          serverCookie: cleanServer,
        }),
      });
      const data = await res.json();
      if (data.success) {
        const detectedAddr = data.serverAddress || data.displayName;
        if (detectedAddr) {
          setServerAddress(detectedAddr);
          if (!displayName || displayName === 'My Aternos Server' || displayName === serverAddress) {
            setDisplayName(detectedAddr);
          }
        }
        if (data.serverCookie) {
          setServerCookie(data.serverCookie);
        }
        if (data.software) setSoftware(data.software);
        if (data.version) setVersion(data.version);
        if (data.serverPort) setServerPort(String(data.serverPort));
        if (data.allServers && Array.isArray(data.allServers) && data.allServers.length > 0) {
          setDiscoveredServers(data.allServers);
        }
        setDetectedSuccess(true);
        setDetectError(null);
        setTimeout(() => setDetectedSuccess(false), 5000);
      } else {
        setDetectError(data.message || 'Could not auto-fetch server details. Please check your session cookie.');
      }
    } catch (err: any) {
      setDetectError(`Connection error: ${err.message}`);
    } finally {
      setIsDetecting(false);
    }
  };

  const handleSessionChange = (rawVal: string) => {
    let val = rawVal;
    setDetectError(null);

    // If user pasted a full cookie header with ATERNOS_SERVER
    const serverMatch = val.match(/ATERNOS_SERVER=([^;\s]+)/i);
    let currentServerCookie = serverCookie;
    if (serverMatch) {
      currentServerCookie = serverMatch[1].trim();
      setServerCookie(currentServerCookie);
    }

    const sessionMatch = val.match(/ATERNOS_SESSION=([^;\s]+)/i);
    if (sessionMatch) {
      val = sessionMatch[1].trim();
    }
    setSessionCookie(val);

    // If user pasted text containing an aternos address
    const addressMatch = rawVal.match(/([a-zA-Z0-9_\-]+)\.aternos\.me/i);
    if (addressMatch) {
      const domain = `${addressMatch[1]}.aternos.me`;
      setServerAddress(domain);
      setDisplayName(domain);
    }

    if (val.trim().length >= 10) {
      handleAutoDetect(val, currentServerCookie);
    }
  };

  const handleServerCookieChange = (val: string) => {
    setServerCookie(val);
    setDetectError(null);

    const sessionMatch = val.match(/ATERNOS_SESSION=([^;\s]+)/i);
    let curSession = sessionCookie;
    if (sessionMatch) {
      curSession = sessionMatch[1].trim();
      setSessionCookie(curSession);
    }

    const serverMatch = val.match(/ATERNOS_SERVER=([^;\s]+)/i);
    if (serverMatch) {
      val = serverMatch[1].trim();
      setServerCookie(val);
    }

    if (val.trim().length >= 4) {
      handleAutoDetect(curSession, val);
    }
  };

  const handleServerAddressChange = (val: string) => {
    setServerAddress(val);
    if (!displayName || displayName === serverAddress) {
      setDisplayName(val);
    }
  };

  const handleSaveForm = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanAddress = serverAddress.trim();
    if (!cleanAddress) return;

    const formattedAddress = cleanAddress.includes('.') ? cleanAddress : `${cleanAddress}.aternos.me`;
    const finalDisplayName = displayName.trim() || formattedAddress;

    if (isAddingNew) {
      onAddServer({
        name: finalDisplayName,
        serverIp: formattedAddress,
        serverPort: serverPort.trim() || '25565',
        software,
        version: version.trim() || '1.20.4',
        sessionCookie: sessionCookie.trim(),
        serverCookie: serverCookie.trim(),
        cfClearanceCookie: cfClearanceCookie.trim(),
      });
      setIsAddingNew(false);
    } else if (editingId) {
      onUpdateServer(editingId, {
        name: finalDisplayName,
        serverIp: formattedAddress,
        serverPort: serverPort.trim() || '25565',
        software,
        version: version.trim() || '1.20.4',
        sessionCookie: sessionCookie.trim(),
        serverCookie: serverCookie.trim(),
        cfClearanceCookie: cfClearanceCookie.trim(),
      });
      setEditingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/85">
      <div className="relative w-full max-w-2xl rounded-2xl sm:rounded-3xl bg-zinc-900 border border-zinc-700 shadow-2xl overflow-hidden flex flex-col max-h-[92vh] sm:max-h-[88vh] transform-gpu">
        
        {/* Sticky Header - Solid background without backdrop-blur to prevent Chrome scroll tearing */}
        <div className="px-4 py-3.5 sm:px-6 sm:py-4 border-b border-zinc-800 shrink-0 bg-zinc-900 flex items-center justify-between z-10">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center shrink-0 shadow-inner">
              <Server className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-bold text-white tracking-tight uppercase font-mono truncate">
                Server Profiles
              </h3>
              <p className="text-[11px] sm:text-xs text-zinc-400 truncate">
                Real-time 1:1 sync with Aternos dashboard
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-2 -mr-1 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body - min-h-0 and isolate prevent Chrome scroll cutting & height miscalculations */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3.5 sm:p-6 space-y-4 overscroll-contain transform-gpu isolate">
          
          {/* Action Row when viewing list */}
          {!isAddingNew && !editingId && (
            <div className="flex items-center justify-between pb-1">
              <span className="text-xs font-mono font-medium text-zinc-400">
                {servers.length} {servers.length === 1 ? 'Registered Server' : 'Registered Servers'}
              </span>
              <button
                onClick={startCreate}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-mono font-bold text-black bg-white hover:bg-zinc-200 transition-all cursor-pointer shadow-md active:scale-95"
              >
                <Plus className="w-4 h-4" />
                <span>Add Server</span>
              </button>
            </div>
          )}

          {/* Form: Add or Edit */}
          {(isAddingNew || editingId) ? (
            <form onSubmit={handleSaveForm} className="space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs sm:text-sm font-mono font-bold text-white uppercase tracking-wide">
                    {isAddingNew ? 'Create Server Profile' : 'Edit Server Profile'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsAddingNew(false);
                    setEditingId(null);
                  }}
                  className="px-2.5 py-1 text-xs text-zinc-400 hover:text-white font-mono rounded-lg hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>

              {/* CARD 1: Identity */}
              <div className="p-3.5 sm:p-4 rounded-xl bg-zinc-950/80 border border-zinc-800 space-y-3">
                <div className="text-[11px] font-mono font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-blue-400" />
                  <span>1. Server Address & Title</span>
                </div>

                <div>
                  <label className="block text-xs font-mono font-bold text-zinc-200 mb-1">
                    Server Address (Domain / IP)
                  </label>
                  <div className="relative">
                    <Server className="w-4 h-4 text-zinc-500 absolute left-3 top-3 pointer-events-none" />
                    <input
                      type="text"
                      value={serverAddress}
                      onChange={e => handleServerAddressChange(e.target.value)}
                      placeholder="e.g. myserver.aternos.me"
                      required
                      className="w-full pl-9 pr-3 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-sm font-mono text-white placeholder:text-zinc-600 focus:outline-none focus:border-white transition-colors"
                    />
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1 font-mono">
                    Your Aternos server address. If you type without .aternos.me, it will be added automatically.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-mono font-bold text-zinc-200 mb-1">
                    Display Name (Nickname)
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    placeholder="e.g. Survival SMP"
                    required
                    className="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-700 rounded-xl text-sm font-mono text-white placeholder:text-zinc-600 focus:outline-none focus:border-white transition-colors"
                  />
                </div>
              </div>

              {/* CARD 2: Aternos Session & Auto-Fetch */}
              <div className="p-3.5 sm:p-4 rounded-xl bg-zinc-950/80 border border-zinc-800 space-y-3.5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="text-[11px] font-mono font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-amber-400" />
                    <span>2. Aternos Session & Credentials</span>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleAutoDetect()}
                    disabled={isDetecting}
                    className="text-xs font-mono font-bold text-black bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center justify-center gap-1.5 shadow-sm active:scale-95"
                  >
                    {isDetecting ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Fetching Aternos Specs...</span>
                      </>
                    ) : detectedSuccess ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Synced 1:1 from Aternos!</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Auto-Fetch Specs</span>
                      </>
                    )}
                  </button>
                </div>

                {detectError && (
                  <div className="p-3 rounded-xl bg-red-950/40 border border-red-800/60 text-xs text-red-300 font-mono flex items-start gap-2">
                    <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    <span>{detectError}</span>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-mono text-zinc-300 mb-1">
                    ATERNOS_SESSION Cookie
                  </label>
                  <textarea
                    rows={2}
                    value={sessionCookie}
                    onChange={e => handleSessionChange(e.target.value)}
                    placeholder="Paste ATERNOS_SESSION cookie or entire cookie header here..."
                    className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-xs font-mono text-white placeholder:text-zinc-600 focus:outline-none focus:border-white break-all transition-colors"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1 font-mono">
                    Found in Browser DevTools (F12) → Application → Cookies → aternos.org → ATERNOS_SESSION
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-mono text-zinc-300 mb-1">
                    ATERNOS_SERVER Cookie (Server ID)
                  </label>
                  <input
                    type="text"
                    value={serverCookie}
                    onChange={e => handleServerCookieChange(e.target.value)}
                    placeholder="e.g. C97GPgj1GU2y7wWc or ATobOAQ3Dq2guih6"
                    className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-xs font-mono text-white placeholder:text-zinc-600 focus:outline-none focus:border-white transition-colors"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1 font-mono">
                    Unique per server on multi-server accounts. Auto-filled when clicking Auto-Fetch!
                  </p>
                </div>

                {/* Discovered Servers Pills on Multi-Server Accounts */}
                {discoveredServers.length > 0 && (
                  <div className="p-3 rounded-xl bg-zinc-900/90 border border-emerald-500/30 space-y-2">
                    <div className="text-[11px] font-mono font-bold text-emerald-400 flex items-center justify-between">
                      <span>Discovered Servers on this Account ({discoveredServers.length}):</span>
                      <span className="text-[10px] text-zinc-400 font-normal">Tap to auto-select</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {discoveredServers.map(s => {
                        const isSelected =
                          serverCookie === s.serverCookie ||
                          serverAddress.toLowerCase() === s.serverAddress.toLowerCase();
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => {
                              setServerAddress(s.serverAddress);
                              setDisplayName(s.serverAddress);
                              setServerCookie(s.serverCookie);
                              setDetectedSuccess(true);
                            }}
                            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer border flex items-center gap-1.5 ${
                              isSelected
                                ? 'bg-white text-black border-white shadow-md'
                                : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700 hover:text-white'
                            }`}
                          >
                            <Server className="w-3 h-3" />
                            <span>{s.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* CARD 3: Server Specs (Port, Software, Version) */}
              <div className="p-3.5 sm:p-4 rounded-xl bg-zinc-950/80 border border-zinc-800 space-y-3">
                <div className="text-[11px] font-mono font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                  <Wifi className="w-3.5 h-3.5 text-purple-400" />
                  <span>3. Server Specs (Auto-Synced with Aternos)</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-mono text-zinc-300 mb-1">
                      Server Port
                    </label>
                    <input
                      type="text"
                      value={serverPort}
                      onChange={e => setServerPort(e.target.value)}
                      placeholder="25565"
                      className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-xs font-mono text-white placeholder:text-zinc-600 focus:outline-none focus:border-white transition-colors"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-mono text-zinc-300 mb-1">
                      Software
                    </label>
                    <select
                      value={software}
                      onChange={e => setSoftware(e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-xs font-mono text-white focus:outline-none focus:border-white cursor-pointer transition-colors"
                    >
                      {SOFTWARE_OPTIONS.map(opt => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-mono text-zinc-300 mb-1">
                      Minecraft Version
                    </label>
                    <input
                      type="text"
                      value={version}
                      onChange={e => setVersion(e.target.value)}
                      placeholder="1.20.4"
                      className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-xl text-xs font-mono text-white placeholder:text-zinc-600 focus:outline-none focus:border-white transition-colors"
                    />
                  </div>
                </div>
              </div>

              {/* Form Action Buttons */}
              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsAddingNew(false);
                    setEditingId(null);
                  }}
                  className="px-4 py-2.5 rounded-xl text-xs font-mono font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-xl text-xs font-mono font-bold text-black bg-white hover:bg-zinc-200 transition-all cursor-pointer shadow-md active:scale-95 flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>{isAddingNew ? 'Save Server' : 'Save Changes'}</span>
                </button>
              </div>
            </form>
          ) : (
            /* Server Profiles List */
            <div className="space-y-3">
              {servers.map(server => {
                const isActive = server.id === activeServerId;
                const key = (server.serverIp || server.name || server.id).toLowerCase();
                const profileState =
                  serverStates[server.id] ||
                  serverStates[key] ||
                  serverStates[server.serverIp.toLowerCase()] ||
                  serverStates[server.name.toLowerCase()];

                const status = profileState?.status || (server.status || 'offline');
                const isOnline = status === 'online';
                const isStarting = status === 'starting' || status === 'loading';
                const isStopping = status === 'stopping';

                const livePort = profileState?.serverPort || server.serverPort || '25565';
                const liveSoftware = profileState?.software || server.software || 'Paper / Bukkit';
                const liveVersion = profileState?.version || server.version || '1.20.4';
                const playersOnline = profileState?.playersOnline ?? 0;
                const maxPlayers = profileState?.maxPlayers ?? 20;
                const hasPlayerList = Boolean(profileState?.playerList && profileState.playerList.length > 0);

                return (
                  <div
                    key={server.id}
                    className={`p-3.5 sm:p-4 rounded-2xl border transition-all flex flex-col gap-3 ${
                      isActive
                        ? 'bg-zinc-950 border-zinc-500 shadow-lg ring-1 ring-white/10'
                        : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    {/* Top Row: Name, Status Badge, Active Badge */}
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                            isOnline
                              ? 'bg-emerald-400 animate-pulse'
                              : isStarting
                              ? 'bg-amber-400 animate-pulse'
                              : isStopping
                              ? 'bg-orange-400'
                              : 'bg-zinc-600'
                          }`}
                        />
                        <span className="font-bold text-sm sm:text-base text-white font-mono truncate">
                          {server.serverIp || server.name}
                        </span>
                        {server.name && server.name !== server.serverIp && (
                          <span className="text-xs text-zinc-400 font-mono truncate hidden sm:inline">
                            ({server.name})
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {isActive && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-white text-black shadow-sm">
                            ACTIVE
                          </span>
                        )}
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase border ${
                            isOnline
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                              : isStarting
                              ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                              : isStopping
                              ? 'bg-orange-500/15 text-orange-300 border-orange-500/30'
                              : 'bg-zinc-800 text-zinc-400 border-zinc-750'
                          }`}
                        >
                          {isOnline ? 'ONLINE' : isStarting ? 'STARTING' : isStopping ? 'STOPPING' : 'OFFLINE'}
                        </span>
                      </div>
                    </div>

                    {/* Middle Row: Live Specs (Port, Software, Version, Players) */}
                    <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-zinc-400">
                      <span className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300">
                        Port: <strong className="text-white">{livePort}</strong>
                      </span>
                      <span className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300">
                        {liveSoftware}
                      </span>
                      <span className="px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300">
                        v{liveVersion}
                      </span>

                      {isOnline && (
                        <span className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-semibold">
                          <Users className="w-3 h-3" />
                          <span>{playersOnline}/{maxPlayers} online</span>
                        </span>
                      )}

                      {profileState?.countdownActive && profileState.countdownFormatted && (
                        <span className="px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 font-bold">
                          ⏳ {profileState.countdownFormatted}
                        </span>
                      )}
                    </div>

                    {/* Online Players Chips Preview */}
                    {isOnline && hasPlayerList && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        <span className="text-[11px] font-mono text-zinc-500">Players:</span>
                        {profileState.playerList?.map(p => (
                          <span
                            key={p}
                            className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-zinc-900 border border-emerald-500/30 text-emerald-300"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Bottom Action Row (Mobile Optimized Buttons) */}
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-zinc-850">
                      <div>
                        {!isActive ? (
                          <button
                            type="button"
                            onClick={() => {
                              onSelectServer(server.id);
                              onClose();
                            }}
                            className="px-3.5 py-1.5 rounded-xl text-xs font-mono font-bold text-zinc-200 hover:text-white bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 transition-all cursor-pointer flex items-center gap-1.5 shadow-sm active:scale-95"
                          >
                            <span>Switch To Server</span>
                            <ArrowRight className="w-3 h-3" />
                          </button>
                        ) : (
                          <span className="text-xs font-mono text-emerald-400 flex items-center gap-1">
                            <Check className="w-3.5 h-3.5" /> Currently Active
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(server)}
                          className="px-3 py-1.5 rounded-xl text-xs font-mono text-zinc-300 hover:text-white bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors cursor-pointer flex items-center gap-1.5"
                          title="Edit server"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                          <span>Edit</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onDeleteServer(server.id)}
                          className="p-1.5 rounded-xl text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                          title="Delete server profile"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}

              {servers.length === 0 && (
                <div className="text-center py-10 px-4 rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 space-y-3">
                  <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mx-auto text-zinc-500">
                    <Server className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-white mb-1">No Server Profiles Configured</p>
                    <p className="text-xs text-zinc-400 max-w-sm mx-auto">
                      Add your Aternos Minecraft server credentials to begin monitoring &amp; continuous automation.
                    </p>
                  </div>
                  <button
                    onClick={startCreate}
                    className="px-4 py-2.5 rounded-xl text-xs font-mono font-bold text-black bg-white hover:bg-zinc-200 transition-all cursor-pointer inline-flex items-center gap-1.5 shadow-md active:scale-95"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Add Server Profile</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 sm:px-6 sm:py-3.5 border-t border-zinc-800 bg-zinc-900/95 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-mono text-zinc-300 hover:text-white transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
