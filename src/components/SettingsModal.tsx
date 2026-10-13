import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Key, Server, Save, RotateCcw, Eye, EyeOff, Loader2, Check, Sparkles, HelpCircle } from 'lucide-react';
import type { SessionConfig } from '../types/aternos.ts';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: Partial<SessionConfig>) => Promise<void>;
  currentConfig: SessionConfig;
  serverName?: string;
}

const DEFAULT_SESSION = '';
const DEFAULT_SERVER = '';
const DEFAULT_ADDRESS = 'myserver.aternos.me';

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onSave,
  currentConfig,
  serverName = 'Active Server',
}) => {
  const [displayName, setDisplayName] = useState('');
  const [sessionCookie, setSessionCookie] = useState('');
  const [serverCookie, setServerCookie] = useState('');
  const [serverAddress, setServerAddress] = useState('');
  const [cfClearanceCookie, setCfClearanceCookie] = useState('');
  const [userAgent, setUserAgent] = useState('');
  const [showSession, setShowSession] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectedSuccess, setDetectedSuccess] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [discoveredServers, setDiscoveredServers] = useState<
    Array<{ id: string; name: string; serverAddress: string; serverCookie: string }>
  >([]);

  useEffect(() => {
    if (isOpen) {
      setSessionCookie(currentConfig.sessionCookie || DEFAULT_SESSION);
      setServerCookie(currentConfig.serverCookie || DEFAULT_SERVER);
      setServerAddress(currentConfig.serverAddress || DEFAULT_ADDRESS);
      setCfClearanceCookie(currentConfig.cfClearanceCookie || '');
      setUserAgent(currentConfig.userAgent || (typeof navigator !== 'undefined' ? navigator.userAgent : ''));
      setDisplayName(currentConfig.name || serverName || 'My Minecraft Server');
      setDetectedSuccess(false);
      setDetectError(null);
      setDiscoveredServers([]);
    }
  }, [isOpen, currentConfig, serverName]);

  const handleResetDefaults = () => {
    setSessionCookie(DEFAULT_SESSION);
    setServerCookie(DEFAULT_SERVER);
    setServerAddress(DEFAULT_ADDRESS);
    setDisplayName('My Minecraft Server');
    setDetectedSuccess(false);
    setDetectError(null);
    setDiscoveredServers([]);
  };

  const handleAutoDetect = async (sessionVal = sessionCookie, serverVal = serverCookie) => {
    let cleanSession = sessionVal.trim();
    let cleanServer = serverVal.trim();

    if (!cleanSession && currentConfig?.sessionCookie && !currentConfig.sessionCookie.includes('...')) {
      cleanSession = currentConfig.sessionCookie.trim();
    }
    if (!cleanServer && currentConfig?.serverCookie) {
      cleanServer = currentConfig.serverCookie.trim();
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
          setDisplayName(detectedAddr);
        }
        if (data.serverCookie) {
          setServerCookie(data.serverCookie);
        }
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

  const handleSessionChange = (val: string) => {
    setSessionCookie(val);
    setDetectError(null);

    const serverMatch = val.match(/ATERNOS_SERVER=([^;\s]+)/i);
    let currentServer = serverCookie;
    if (serverMatch && serverMatch[1]) {
      currentServer = serverMatch[1].trim();
      setServerCookie(currentServer);
    }

    const cfMatch = val.match(/cf_clearance=([^;\s]+)/i);
    if (cfMatch && cfMatch[1]) {
      setCfClearanceCookie(cfMatch[1].trim());
    }

    const sessionMatch = val.match(/ATERNOS_SESSION=([^;\s]+)/i);
    const cleanSession = sessionMatch ? sessionMatch[1].trim() : val.trim();

    if (cleanSession && cleanSession.length > 15) {
      handleAutoDetect(cleanSession, currentServer);
    }
  };

  const handleServerCookieChange = (val: string) => {
    setServerCookie(val);
    setDetectError(null);
    const serverMatch = val.match(/ATERNOS_SERVER=([^;\s]+)/i);
    const cleanServer = serverMatch ? serverMatch[1].trim() : val.trim();
    if (cleanServer && cleanServer.length >= 8 && sessionCookie && sessionCookie.length > 15) {
      handleAutoDetect(sessionCookie, cleanServer);
    }
  };

  const handleServerAddressChange = (val: string) => {
    setServerAddress(val);
    if (!displayName || displayName === serverAddress) {
      setDisplayName(val);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      let finalServerCookie = serverCookie.trim();
      if (!finalServerCookie && discoveredServers.length > 0) {
        finalServerCookie = discoveredServers[0].serverCookie;
      }

      await onSave({
        sessionCookie: sessionCookie.trim(),
        serverCookie: finalServerCookie,
        serverAddress: serverAddress.trim(),
        cfClearanceCookie: cfClearanceCookie.trim(),
        userAgent: userAgent.trim(),
        name: displayName.trim() || serverAddress.trim(),
      });
      onClose();
    } catch {
      // handled
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/80 backdrop-blur-md"
          />

          {/* Modal Container */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="relative w-full max-w-xl max-h-[92vh] overflow-y-auto bg-zinc-950 border border-white/10 rounded-3xl shadow-2xl p-5 sm:p-7 z-10 no-scrollbar"
          >
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-white/[0.06]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-zinc-900 border border-white/10 flex items-center justify-center text-white">
                  <Key className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white font-sans">Session Auth & Credentials</h3>
                  <p className="text-xs text-zinc-400">Configure your personal Aternos account cookies</p>
                </div>
              </div>

              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={onClose}
                className="p-2 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </motion.button>
            </div>

            {/* Quick helper tip */}
            <div className="mt-4 p-3.5 rounded-2xl bg-zinc-900/80 border border-white/[0.06] flex items-start gap-3 text-xs text-zinc-400 leading-relaxed">
              <HelpCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>
                Log in to <a href="https://aternos.org/servers/" target="_blank" rel="noreferrer" className="text-white underline font-semibold">aternos.org</a>, open DevTools (<kbd className="font-mono text-zinc-300">F12</kbd> &rarr; Application &rarr; Cookies), and copy your <strong className="text-white font-mono">ATERNOS_SESSION</strong> cookie.
              </span>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              {/* ATERNOS_SESSION */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-mono font-bold text-zinc-200">
                    ATERNOS_SESSION Cookie
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowSession(!showSession)}
                    className="text-[11px] font-mono text-zinc-400 hover:text-white flex items-center gap-1 cursor-pointer"
                  >
                    {showSession ? (
                      <>
                        <EyeOff className="w-3.5 h-3.5" /> Hide
                      </>
                    ) : (
                      <>
                        <Eye className="w-3.5 h-3.5" /> Reveal
                      </>
                    )}
                  </button>
                </div>
                <textarea
                  rows={3}
                  value={sessionCookie}
                  onChange={e => handleSessionChange(e.target.value)}
                  placeholder="Paste your ATERNOS_SESSION cookie or entire Cookie header..."
                  className="w-full px-3.5 py-2.5 bg-zinc-900/90 border border-white/10 rounded-2xl text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-400 transition-colors break-all"
                  required
                />
              </div>

              {/* Discovered Servers List */}
              {discoveredServers.length > 0 && (
                <div className="p-3.5 rounded-2xl bg-zinc-900/90 border border-emerald-500/30">
                  <div className="text-[11px] font-mono font-bold text-emerald-400 mb-2 flex items-center justify-between">
                    <span>Discovered Servers on Account ({discoveredServers.length}):</span>
                    <span className="text-[10px] text-zinc-400 font-normal">Click to select</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {discoveredServers.map(s => {
                      const isSelected = serverCookie === s.serverCookie || serverAddress.toLowerCase() === s.serverAddress.toLowerCase();
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
                          className={`px-3 py-1.5 rounded-full text-xs font-mono font-bold transition-all cursor-pointer border ${
                            isSelected
                              ? 'bg-white text-zinc-950 border-white shadow-md'
                              : 'bg-zinc-950 text-zinc-300 border-white/10 hover:bg-zinc-800 hover:text-white'
                          }`}
                        >
                          {s.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ATERNOS_SERVER */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-mono font-bold text-zinc-200">
                    ATERNOS_SERVER Cookie / ID
                  </label>
                  <motion.button
                    whileTap={{ scale: 0.94 }}
                    type="button"
                    onClick={() => handleAutoDetect()}
                    disabled={isDetecting}
                    className="text-[11px] font-mono text-zinc-300 hover:text-white flex items-center gap-1.5 px-3 py-1 rounded-full bg-zinc-900 hover:bg-zinc-800 border border-white/10 cursor-pointer shadow-sm"
                  >
                    {isDetecting ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin text-emerald-400" /> Fetching...
                      </>
                    ) : detectedSuccess ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" /> Auto-fetched!
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3 h-3 text-emerald-400" /> Auto-Detect
                      </>
                    )}
                  </motion.button>
                </div>
                <input
                  type="text"
                  value={serverCookie}
                  onChange={e => handleServerCookieChange(e.target.value)}
                  placeholder="e.g. C97GPgj1GU2y7wWc"
                  className="w-full px-3.5 py-2.5 bg-zinc-900/90 border border-white/10 rounded-2xl text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-400 transition-colors"
                />
              </div>

              {/* Display Name */}
              <div>
                <label className="block text-xs font-mono font-bold text-zinc-200 mb-1.5">
                  Server Display Name
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="e.g. My Survival Server"
                  className="w-full px-3.5 py-2.5 bg-zinc-900/90 border border-white/10 rounded-2xl text-xs font-sans text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-400 transition-colors"
                  required
                />
              </div>

              {/* Server Address */}
              <div>
                <label className="block text-xs font-mono font-bold text-zinc-200 mb-1.5">
                  Server Address (.aternos.me)
                </label>
                <div className="relative">
                  <Server className="w-4 h-4 text-zinc-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    value={serverAddress}
                    onChange={e => handleServerAddressChange(e.target.value)}
                    placeholder="e.g. myserver.aternos.me"
                    className="w-full pl-10 pr-3.5 py-2.5 bg-zinc-900/90 border border-white/10 rounded-2xl text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-400 transition-colors"
                    required
                  />
                </div>
              </div>

              {/* Error notice if auto-fetch fails */}
              {detectError && (
                <div className="p-3.5 rounded-2xl bg-rose-950/40 border border-rose-800/60 text-xs text-rose-300 font-mono">
                  {detectError}
                </div>
              )}

              {/* Actions */}
              <div className="pt-4 border-t border-white/[0.06] flex items-center justify-between gap-3">
                <motion.button
                  whileTap={{ scale: 0.94 }}
                  type="button"
                  onClick={handleResetDefaults}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-mono text-zinc-400 hover:text-white hover:bg-zinc-900 transition-colors cursor-pointer border border-white/[0.06]"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset</span>
                </motion.button>

                <div className="flex items-center gap-2">
                  <motion.button
                    whileTap={{ scale: 0.94 }}
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 rounded-full text-xs font-mono text-zinc-400 hover:text-white transition-colors cursor-pointer"
                  >
                    Cancel
                  </motion.button>
                  <motion.button
                    whileTap={{ scale: 0.94 }}
                    type="submit"
                    disabled={isSaving}
                    className="flex items-center gap-1.5 px-5 py-2 rounded-full text-xs font-mono font-bold text-zinc-950 bg-white hover:bg-zinc-200 transition-colors shadow-lg cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{isSaving ? 'Saving...' : 'Save & Link'}</span>
                  </motion.button>
                </div>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
