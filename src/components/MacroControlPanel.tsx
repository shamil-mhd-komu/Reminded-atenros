import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Zap, RefreshCw, Shield, Clock, Timer, CheckCircle2, Play } from 'lucide-react';
import type { MacroRule, ServerProfile } from '../types/aternos.ts';

export const DEFAULT_PROFILE_MACROS: MacroRule[] = [
  {
    id: 'macro-extend-interval',
    name: 'Auto Add Timer (+1 Keepalive)',
    description: 'When enabled, it will automatically click +1 when timer reaches below 1:00.',
    type: 'extend_interval',
    enabled: true,
    lastRunTimestamp: null,
    nextRunTimestamp: null,
    runCount: 0,
  },
  {
    id: 'macro-afk-watchdog',
    name: '24/7 AFK Watchdog',
    description: 'Automatically detects if the server is offline or crashed and restarts it to maintain 24/7 continuous uptime',
    type: 'afk_watchdog',
    enabled: false,
    intervalMinutes: 1,
    lastRunTimestamp: null,
    nextRunTimestamp: null,
    runCount: 0,
  },
  {
    id: 'macro-restart-interval',
    name: 'Interval Server Restart',
    description: 'Automatically restart the server every X hours to refresh memory and clear lag',
    type: 'restart_interval',
    enabled: false,
    intervalMinutes: 60,
    lastRunTimestamp: null,
    nextRunTimestamp: null,
    runCount: 0,
  },
  {
    id: 'macro-restart-daily',
    name: 'Daily Schedule Restart',
    description: 'Restart server everyday at a designated clock time (e.g. 06:30 AM)',
    type: 'restart_daily',
    enabled: false,
    dailyTime: '06:30',
    lastRunTimestamp: null,
    nextRunTimestamp: null,
    runCount: 0,
  },
];

interface MacroControlPanelProps {
  server: ServerProfile | null;
  serverStatus: string;
  countdownSeconds?: number | null;
  countdownFormatted?: string | null;
  playersOnline?: number;
  onRestart: () => void;
  onExtend: () => void;
  isActionLoading: boolean;
  addToast: (type: 'success' | 'error' | 'info' | 'warning', message: string) => void;
  onUpdateServerMacros?: (serverId: string, macros: MacroRule[]) => void;
}

export const MacroControlPanel: React.FC<MacroControlPanelProps> = ({
  server,
  serverStatus,
  countdownSeconds,
  countdownFormatted,
  playersOnline = 0,
  onRestart,
  onExtend,
  isActionLoading,
  addToast,
  onUpdateServerMacros,
}) => {
  const [macros, setMacros] = useState<MacroRule[]>(() => {
    if (server?.macros && Array.isArray(server.macros) && server.macros.length > 0) {
      return server.macros;
    }
    return JSON.parse(JSON.stringify(DEFAULT_PROFILE_MACROS));
  });

  const [now, setNow] = useState(Date.now());
  const [customInterval, setCustomInterval] = useState<{ [id: string]: string }>({});

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // When active server changes, switch to that server's own macros
  useEffect(() => {
    if (!server) return;

    if (server.macros && Array.isArray(server.macros) && server.macros.length > 0) {
      setMacros(server.macros);
      return;
    }

    // Otherwise query backend for this specific server's macros
    fetch(`/api/macros?server=${encodeURIComponent(server.serverIp || server.id)}`)
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setMacros(data);
          onUpdateServerMacros?.(server.id, data);
        } else {
          const fresh = JSON.parse(JSON.stringify(DEFAULT_PROFILE_MACROS));
          setMacros(fresh);
          onUpdateServerMacros?.(server.id, fresh);
        }
      })
      .catch(() => {
        const fresh = JSON.parse(JSON.stringify(DEFAULT_PROFILE_MACROS));
        setMacros(fresh);
      });
  }, [server?.id, server?.serverIp]);

  const saveMacros = (updatedRules: MacroRule[]) => {
    setMacros(updatedRules);
    if (!server) return;

    // 1. Update in-memory & localStorage profile via App.tsx handler
    onUpdateServerMacros?.(server.id, updatedRules);

    // 2. Persist to backend for this specific server profile
    fetch(`/api/macros?server=${encodeURIComponent(server.serverIp || server.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverAddress: server.serverIp,
        serverId: server.id,
        rules: updatedRules,
      }),
    }).catch(() => {});
  };

  const handleToggle = (id: string) => {
    const updated = macros.map(m => {
      if (m.id === id) {
        const willEnable = !m.enabled;
        let nextRun = m.nextRunTimestamp;
        if (willEnable) {
          if (m.type === 'restart_interval' || m.type === 'extend_interval') {
            const mins = m.intervalMinutes || 60;
            nextRun = Date.now() + mins * 60 * 1000;
          } else if (m.type === 'restart_daily' && m.dailyTime) {
            nextRun = calculateNextDaily(m.dailyTime);
          }
        }
        return { ...m, enabled: willEnable, nextRunTimestamp: willEnable ? nextRun : null };
      }
      return m;
    });

    saveMacros(updated);

    const target = updated.find(m => m.id === id);
    const serverName = server?.name || 'Server';
    if (target?.enabled) {
      addToast('success', `${target.name} armed for ${serverName}.`);
    } else {
      addToast('info', `${target?.name} paused for ${serverName}.`);
    }
  };

  const calculateNextDaily = (timeStr: string): number => {
    const [h, m] = timeStr.split(':').map(n => parseInt(n, 10));
    const target = new Date();
    target.setHours(h || 0, m || 0, 0, 0);
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  };

  const handleSetIntervalMinutes = (id: string, minutes: number) => {
    const updated = macros.map(m => {
      if (m.id === id) {
        return {
          ...m,
          intervalMinutes: minutes,
          nextRunTimestamp: m.enabled ? Date.now() + minutes * 60 * 1000 : m.nextRunTimestamp,
        };
      }
      return m;
    });
    saveMacros(updated);
    addToast('info', `Interval set to ${formatIntervalDuration(minutes)}.`);
  };

  const handleSetDailyTime = (id: string, time24: string) => {
    const updated = macros.map(m => {
      if (m.id === id) {
        const next = m.enabled ? calculateNextDaily(time24) : m.nextRunTimestamp;
        return {
          ...m,
          dailyTime: time24,
          nextRunTimestamp: next,
        };
      }
      return m;
    });
    saveMacros(updated);
    addToast('info', `Daily schedule updated to ${formatTime12h(time24)}.`);
  };

  const handleManualTrigger = async (id: string) => {
    const target = macros.find(m => m.id === id);
    if (!target || !server) return;

    try {
      const res = await fetch(`/api/macros/trigger/${id}?server=${encodeURIComponent(server.serverIp || server.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverAddress: server.serverIp,
          serverId: server.id,
        }),
      });
      const data = await res.json();
      if (data.success) {
        addToast('success', data.message || `Triggered ${target.name}.`);
      } else {
        addToast('error', data.message || 'Action failed.');
      }
    } catch {
      if (target.type === 'restart_interval' || target.type === 'restart_daily') {
        onRestart();
      } else {
        onExtend();
      }
    }
  };

  const formatIntervalDuration = (mins: number) => {
    if (mins >= 60) {
      const h = Math.floor(mins / 60);
      const rem = mins % 60;
      return rem > 0 ? `${h}h ${rem}m` : `${h} Hour${h > 1 ? 's' : ''}`;
    }
    return `${mins} Minute${mins > 1 ? 's' : ''}`;
  };

  const formatTime12h = (time24?: string) => {
    if (!time24) return '--:--';
    const [h, m] = time24.split(':').map(n => parseInt(n, 10));
    if (isNaN(h) || isNaN(m)) return time24;
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${m < 10 ? '0' : ''}${m} ${period}`;
  };

  const formatRemainingCountdown = (targetTimestamp: number | null) => {
    if (!targetTimestamp) return '--:--';
    const diffSec = Math.max(0, Math.floor((targetTimestamp - now) / 1000));
    if (diffSec <= 0) return 'Executing...';

    const h = Math.floor(diffSec / 3600);
    const m = Math.floor((diffSec % 3600) / 60);
    const s = diffSec % 60;

    if (h > 0) {
      return `${h}h ${m < 10 ? '0' : ''}${m}m ${s < 10 ? '0' : ''}${s}s`;
    }
    return `${m}m ${s < 10 ? '0' : ''}${s}s`;
  };

  const activeCount = macros.filter(m => m.enabled).length;

  return (
    <div className="bg-zinc-900/60 border border-white/[0.08] rounded-3xl p-5 sm:p-7 shadow-xl backdrop-blur-xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-5 border-b border-white/[0.06]">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Zap className="w-4 h-4" />
            </div>
            <h3 className="text-base sm:text-lg font-bold text-white tracking-tight font-sans">
              24/7 Automation & AFK Engine
            </h3>
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              {activeCount} {activeCount === 1 ? 'Rule Active' : 'Rules Active'}
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Automations operate independently for <strong className="text-zinc-200">{server?.name || 'this server'}</strong>: auto +1 timer below 1:00, crash watchdog, and scheduled reboots
          </p>
        </div>

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => {
            if (!server) return;
            fetch(`/api/macros?server=${encodeURIComponent(server.serverIp || server.id)}`)
              .then(r => r.json())
              .then(data => {
                if (Array.isArray(data) && data.length > 0) {
                  setMacros(data);
                  onUpdateServerMacros?.(server.id, data);
                  addToast('info', `Macros refreshed for ${server.name}.`);
                }
              })
              .catch(() => {});
          }}
          title="Sync macro states"
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-mono text-zinc-300 hover:text-white bg-zinc-950/60 hover:bg-zinc-800 border border-white/10 transition-all cursor-pointer shadow-sm self-start sm:self-auto"
        >
          <RefreshCw className="w-3.5 h-3.5 text-zinc-400" />
          <span>Sync Profile Rules</span>
        </motion.button>
      </div>

      {/* Rules Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
        {/* Rule 1: Auto Add Timer (+1 Keepalive) */}
        {macros.find(m => m.type === 'extend_interval') && (() => {
          const m = macros.find(m => m.type === 'extend_interval')!;
          const isUnderOneMin = countdownSeconds !== null && countdownSeconds !== undefined && countdownSeconds <= 60 && countdownSeconds > 0;

          return (
            <motion.div
              key={m.id}
              whileHover={{ y: -2 }}
              className={`flex flex-col justify-between p-5 rounded-2xl border transition-all ${
                m.enabled
                  ? 'bg-zinc-950/80 border-emerald-500/30 shadow-lg shadow-emerald-500/5'
                  : 'bg-zinc-950/40 border-white/[0.06] opacity-80'
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Timer className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 block">
                        Keepalive Timer
                      </span>
                      <h4 className="text-sm font-bold text-white">
                        Auto Add Timer (+1)
                      </h4>
                    </div>
                  </div>

                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={() => handleToggle(m.id)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      m.enabled ? 'bg-emerald-500' : 'bg-zinc-800'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200 ease-in-out mt-0.5 ml-0.5 ${
                        m.enabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </motion.button>
                </div>

                <p className="text-xs text-zinc-400 mt-2.5 leading-relaxed">
                  When enabled, it will automatically click +1 when timer reaches below 1:00.
                </p>

                <div className="mt-4 p-3 rounded-2xl bg-zinc-900/90 border border-white/[0.06] text-[11px] font-mono text-zinc-300">
                  <div className="flex items-center justify-between">
                    <span>Auto-Extend:</span>
                    <span className={`font-bold ${m.enabled ? 'text-emerald-400' : 'text-zinc-500'}`}>
                      {m.enabled ? '● Active (< 1:00)' : '○ Disabled'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1.5 text-[10px] text-zinc-400">
                    <span>Times clicked:</span>
                    <span className="text-white font-bold">{m.runCount || 0} times</span>
                  </div>
                </div>
              </div>

              <div className="mt-5 pt-3.5 border-t border-white/[0.06] flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-mono text-zinc-400">STATUS</div>
                  <div className="text-xs font-mono font-bold text-white mt-0.5">
                    {!m.enabled ? (
                      <span className="text-zinc-500">Paused</span>
                    ) : serverStatus !== 'online' ? (
                      <span className="text-zinc-400">Waiting for Online</span>
                    ) : playersOnline > 0 ? (
                      <span className="text-emerald-400 font-semibold">
                        Paused ({playersOnline} Active)
                      </span>
                    ) : countdownSeconds !== null && countdownSeconds !== undefined ? (
                      isUnderOneMin ? (
                        <span className="text-emerald-400 font-bold animate-pulse">
                          Clicking +1 now ({countdownFormatted})
                        </span>
                      ) : (
                        <span className="text-zinc-300">
                          Waiting for &lt; 1:00 ({countdownFormatted})
                        </span>
                      )
                    ) : (
                      <span className="text-emerald-400">Armed &bull; Monitoring</span>
                    )}
                  </div>
                </div>

                <motion.button
                  whileTap={playersOnline <= 0 ? { scale: 0.92 } : {}}
                  onClick={() => handleManualTrigger(m.id)}
                  disabled={isActionLoading || serverStatus !== 'online' || playersOnline > 0}
                  title={
                    playersOnline > 0
                      ? `Timer paused (${playersOnline} players online)`
                      : 'Click +1 keepalive timer now'
                  }
                  className={`px-3 py-1 bg-zinc-900 text-white border border-white/10 rounded-full text-xs font-mono font-bold transition-all ${
                    playersOnline > 0
                      ? 'opacity-40 cursor-not-allowed text-zinc-500'
                      : 'hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer'
                  }`}
                >
                  {playersOnline > 0 ? 'Paused' : '+1 Now'}
                </motion.button>
              </div>
            </motion.div>
          );
        })()}

        {/* Rule 2: 24/7 AFK Watchdog */}
        {macros.find(m => m.type === 'afk_watchdog') && (() => {
          const m = macros.find(m => m.type === 'afk_watchdog')!;

          return (
            <motion.div
              key={m.id}
              whileHover={{ y: -2 }}
              className={`flex flex-col justify-between p-5 rounded-2xl border transition-all ${
                m.enabled
                  ? 'bg-zinc-950/80 border-emerald-500/30 shadow-lg shadow-emerald-500/5'
                  : 'bg-zinc-950/40 border-white/[0.06] opacity-80'
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 block">
                        Continuous Guard
                      </span>
                      <h4 className="text-sm font-bold text-white">
                        24/7 AFK Watchdog
                      </h4>
                    </div>
                  </div>

                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={() => handleToggle(m.id)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      m.enabled ? 'bg-emerald-500' : 'bg-zinc-800'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200 ease-in-out mt-0.5 ml-0.5 ${
                        m.enabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </motion.button>
                </div>

                <p className="text-xs text-zinc-400 mt-2.5 leading-relaxed">
                  Continuous guardian loop. Automatically boots server back up if it crashes, stops, or goes offline to guarantee 24/7 uptime.
                </p>

                <div className="mt-4 p-3 rounded-2xl bg-zinc-900/90 border border-white/[0.06] text-[11px] font-mono text-zinc-300">
                  <div className="flex items-center justify-between">
                    <span>Guardian Status:</span>
                    <span className={`font-bold ${m.enabled ? 'text-emerald-400' : 'text-zinc-500'}`}>
                      {m.enabled ? '● Active 24/7' : '○ Disabled'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1.5 text-[10px] text-zinc-400">
                    <span>Auto-recovered:</span>
                    <span className="text-white font-bold">{m.runCount || 0} times</span>
                  </div>
                </div>
              </div>

              <div className="mt-5 pt-3.5 border-t border-white/[0.06] flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-mono text-zinc-400">STATUS</div>
                  <div className="text-xs font-mono font-bold text-white mt-0.5">
                    {serverStatus === 'offline' ? (
                      <span className="text-amber-400">Auto-Start Armed</span>
                    ) : (
                      <span className="text-emerald-400">Online &amp; Guarded</span>
                    )}
                  </div>
                </div>

                <motion.button
                  whileTap={{ scale: 0.92 }}
                  onClick={() => handleManualTrigger(m.id)}
                  disabled={isActionLoading}
                  className="px-3 py-1 bg-zinc-900 hover:bg-zinc-800 text-white border border-white/10 rounded-full text-xs font-mono font-bold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all"
                >
                  Test Run
                </motion.button>
              </div>
            </motion.div>
          );
        })()}

        {/* Rule 3: Interval Restart */}
        {macros.find(m => m.type === 'restart_interval') && (() => {
          const m = macros.find(m => m.type === 'restart_interval')!;
          const currentMins = m.intervalMinutes || 60;

          return (
            <motion.div
              key={m.id}
              whileHover={{ y: -2 }}
              className={`flex flex-col justify-between p-5 rounded-2xl border transition-all ${
                m.enabled
                  ? 'bg-zinc-950/80 border-emerald-500/30 shadow-lg shadow-emerald-500/5'
                  : 'bg-zinc-950/40 border-white/[0.06] opacity-80'
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 block">
                        Periodic Reboot
                      </span>
                      <h4 className="text-sm font-bold text-white">
                        Restart Every X Hours
                      </h4>
                    </div>
                  </div>

                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={() => handleToggle(m.id)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      m.enabled ? 'bg-emerald-500' : 'bg-zinc-800'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200 ease-in-out mt-0.5 ml-0.5 ${
                        m.enabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </motion.button>
                </div>

                <p className="text-xs text-zinc-400 mt-2.5 leading-relaxed">
                  Restart automatically every <strong className="text-white">{formatIntervalDuration(currentMins)}</strong> to refresh RAM and prevent lag.
                </p>

                <div className="mt-4">
                  <div className="text-[11px] font-medium text-zinc-400 mb-1.5 font-mono">Select Interval:</div>
                  <div className="flex flex-wrap gap-1.5">
                    {[60, 120, 240, 360].map(mins => (
                      <button
                        key={mins}
                        onClick={() => handleSetIntervalMinutes(m.id, mins)}
                        className={`px-2.5 py-1 rounded-full text-xs font-mono font-bold transition-all cursor-pointer ${
                          currentMins === mins
                            ? 'bg-white text-zinc-950 shadow-sm'
                            : 'bg-zinc-900 text-zinc-400 hover:text-white border border-white/[0.08]'
                        }`}
                      >
                        {mins >= 60 ? `${mins / 60}h` : `${mins}m`}
                      </button>
                    ))}
                  </div>

                  <div className="mt-2.5 flex items-center gap-1.5">
                    <input
                      type="number"
                      min="5"
                      max="1440"
                      placeholder="Custom mins"
                      value={customInterval[m.id] ?? ''}
                      onChange={e => setCustomInterval({ ...customInterval, [m.id]: e.target.value })}
                      className="w-28 px-3 py-1 bg-zinc-900 border border-white/10 rounded-full text-xs text-white font-mono placeholder:text-zinc-500 focus:outline-none focus:border-emerald-400"
                    />
                    <button
                      onClick={() => {
                        const val = parseInt(customInterval[m.id] || '', 10);
                        if (!isNaN(val) && val >= 5) {
                          handleSetIntervalMinutes(m.id, val);
                          setCustomInterval({ ...customInterval, [m.id]: '' });
                        } else {
                          addToast('warning', 'Please enter a valid interval of at least 5 minutes.');
                        }
                      }}
                      className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 rounded-full text-xs font-mono cursor-pointer"
                    >
                      Set
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-5 pt-3.5 border-t border-white/[0.06] flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-mono text-zinc-400">NEXT TRIGGER</div>
                  <div className="text-xs font-mono font-bold text-white mt-0.5">
                    {m.enabled ? formatRemainingCountdown(m.nextRunTimestamp) : 'Paused'}
                  </div>
                </div>

                <motion.button
                  whileTap={{ scale: 0.92 }}
                  onClick={() => handleManualTrigger(m.id)}
                  disabled={isActionLoading || serverStatus === 'offline'}
                  className="px-3 py-1 bg-zinc-900 hover:bg-zinc-800 text-white border border-white/10 rounded-full text-xs font-mono font-bold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all"
                >
                  Run Now
                </motion.button>
              </div>
            </motion.div>
          );
        })()}

        {/* Rule 4: Daily Scheduled Restart */}
        {macros.find(m => m.type === 'restart_daily') && (() => {
          const m = macros.find(m => m.type === 'restart_daily')!;
          const dailyTime = m.dailyTime || '06:30';

          return (
            <motion.div
              key={m.id}
              whileHover={{ y: -2 }}
              className={`flex flex-col justify-between p-5 rounded-2xl border transition-all ${
                m.enabled
                  ? 'bg-zinc-950/80 border-emerald-500/30 shadow-lg shadow-emerald-500/5'
                  : 'bg-zinc-950/40 border-white/[0.06] opacity-80'
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 block">
                        Clock Time
                      </span>
                      <h4 className="text-sm font-bold text-white">
                        Daily Scheduled Reset
                      </h4>
                    </div>
                  </div>

                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={() => handleToggle(m.id)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      m.enabled ? 'bg-emerald-500' : 'bg-zinc-800'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200 ease-in-out mt-0.5 ml-0.5 ${
                        m.enabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </motion.button>
                </div>

                <p className="text-xs text-zinc-400 mt-2.5 leading-relaxed">
                  Restart automatically every single day at <strong className="text-white">{formatTime12h(dailyTime)}</strong> for morning maintenance.
                </p>

                <div className="mt-4">
                  <div className="text-[11px] font-medium text-zinc-400 mb-1.5 font-mono">Time:</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      value={dailyTime}
                      onChange={e => {
                        if (e.target.value) handleSetDailyTime(m.id, e.target.value);
                      }}
                      className="px-3 py-1 bg-zinc-900 border border-white/10 rounded-full text-xs text-white font-mono focus:outline-none focus:border-emerald-400 cursor-pointer"
                    />
                    <span className="text-xs font-mono text-zinc-300 bg-zinc-900 px-2.5 py-1 rounded-full border border-white/10">
                      {formatTime12h(dailyTime)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-5 pt-3.5 border-t border-white/[0.06] flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-mono text-zinc-400">NEXT TRIGGER</div>
                  <div className="text-xs font-mono font-bold text-white mt-0.5">
                    {m.enabled ? formatRemainingCountdown(m.nextRunTimestamp) : 'Paused'}
                  </div>
                </div>

                <motion.button
                  whileTap={{ scale: 0.92 }}
                  onClick={() => handleManualTrigger(m.id)}
                  disabled={isActionLoading || serverStatus === 'offline'}
                  className="px-3 py-1 bg-zinc-900 hover:bg-zinc-800 text-white border border-white/10 rounded-full text-xs font-mono font-bold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all"
                >
                  Run Now
                </motion.button>
              </div>
            </motion.div>
          );
        })()}
      </div>
    </div>
  );
};
