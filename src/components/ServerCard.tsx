import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Copy, Check, Globe, Edit3, Server as ServerIcon, Users, Wifi } from 'lucide-react';
import type { AternosState } from '../types/aternos.ts';

interface ServerCardProps {
  state: AternosState;
  serverName?: string;
  onCopyAddress: (text: string) => void;
  onEditServer?: () => void;
}

export const ServerCard: React.FC<ServerCardProps> = ({
  state,
  serverName = 'Minecraft Server',
  onCopyAddress,
  onEditServer,
}) => {
  const [copiedMain, setCopiedMain] = useState(false);
  const [copiedDyn, setCopiedDyn] = useState(false);

  const fullAddress =
    state.serverPort && state.serverPort !== '25565'
      ? `${state.serverIp}:${state.serverPort}`
      : state.serverIp;

  const handleCopyMain = () => {
    navigator.clipboard.writeText(fullAddress);
    setCopiedMain(true);
    onCopyAddress(fullAddress);
    setTimeout(() => setCopiedMain(false), 2000);
  };

  const handleCopyDyn = () => {
    if (!state.dynip) return;
    navigator.clipboard.writeText(state.dynip);
    setCopiedDyn(true);
    onCopyAddress(state.dynip);
    setTimeout(() => setCopiedDyn(false), 2000);
  };

  const getStatusBadge = () => {
    switch (state.status) {
      case 'online':
        return {
          pillBg: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
          dotBg: 'bg-emerald-400',
          label: 'ONLINE',
          isLive: true,
          glow: 'from-emerald-500/10 via-emerald-500/5 to-transparent',
        };
      case 'starting':
      case 'loading':
        return {
          pillBg: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
          dotBg: 'bg-amber-400 animate-pulse',
          label: (state.rawStatus || 'BOOTING...').toUpperCase(),
          isLive: false,
          glow: 'from-amber-500/10 via-amber-500/5 to-transparent',
        };
      case 'queue':
        return {
          pillBg: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
          dotBg: 'bg-blue-400',
          label: state.queuePosition ? `IN QUEUE (#${state.queuePosition})` : 'IN QUEUE',
          isLive: false,
          glow: 'from-blue-500/10 via-blue-500/5 to-transparent',
        };
      case 'stopping':
        return {
          pillBg: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
          dotBg: 'bg-orange-400',
          label: 'STOPPING...',
          isLive: false,
          glow: 'from-orange-500/10 via-orange-500/5 to-transparent',
        };
      default:
        return {
          pillBg: 'bg-zinc-800/80 text-zinc-400 border-white/[0.08]',
          dotBg: 'bg-zinc-500',
          label: 'OFFLINE',
          isLive: false,
          glow: 'from-zinc-800/20 via-zinc-900/10 to-transparent',
        };
    }
  };

  const statusBadge = getStatusBadge();

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className="relative overflow-hidden rounded-3xl bg-zinc-900 border border-white/10 shadow-2xl p-6 sm:p-8 isolate"
    >
      {/* Dynamic ambient backdrop glow */}
      <div
        className={`absolute -top-24 -right-24 w-80 h-80 rounded-full bg-gradient-to-br ${statusBadge.glow} blur-3xl pointer-events-none transition-all duration-700`}
      />

      <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
        {/* Left column: Server Info */}
        <div className="space-y-3.5 min-w-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-zinc-800/80 border border-white/10 flex items-center justify-center text-zinc-300 shadow-inner shrink-0">
              <ServerIcon className="w-5 h-5 text-zinc-300" />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white font-sans truncate">
                  {serverName}
                </h2>
                {onEditServer && (
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    whileHover={{ scale: 1.1 }}
                    onClick={onEditServer}
                    className="p-1.5 hover:bg-zinc-800/80 rounded-xl text-zinc-400 hover:text-white transition-colors cursor-pointer"
                    title="Edit server profile"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </motion.button>
                )}
              </div>
            </div>
          </div>

          {/* Metadata chips */}
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-zinc-400">
            {state.software && (
              <span className="px-2.5 py-1 rounded-full bg-zinc-950/60 border border-white/[0.06] text-zinc-300 font-medium">
                {state.software}
              </span>
            )}
            {state.version && (
              <span className="px-2.5 py-1 rounded-full bg-zinc-950/60 border border-white/[0.06] text-zinc-300">
                v{state.version}
              </span>
            )}
            {state.serverPort && (
              <span className="px-2.5 py-1 rounded-full bg-zinc-950/60 border border-white/[0.06] text-zinc-300">
                Port {state.serverPort}
              </span>
            )}
            {state.playersOnline !== undefined && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-semibold">
                <Users className="w-3 h-3" />
                <span>
                  {state.playersOnline}/{state.maxPlayers || 20} Players
                </span>
              </span>
            )}
          </div>

          {/* Connected player heads next to each name */}
          {state.status === 'online' && state.playerList && state.playerList.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>Online Players ({state.playerList.length}):</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {state.playerList.map((player) => (
                  <div
                    key={player}
                    className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-zinc-900/90 border border-emerald-500/25 hover:border-emerald-500/50 text-xs font-mono text-zinc-200 shadow-sm transition-all group"
                  >
                    <img
                      src={`https://mc-heads.net/avatar/${encodeURIComponent(player)}/32`}
                      alt={player}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).src = `https://minotar.net/avatar/${encodeURIComponent(player)}/32.png`;
                      }}
                      className="w-4 h-4 rounded-sm shadow object-cover bg-zinc-800 ring-1 ring-emerald-500/40 group-hover:ring-emerald-400 shrink-0"
                    />
                    <span className="font-semibold text-emerald-300 group-hover:text-emerald-200">
                      {player}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Copyable Address Cards */}
          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            {/* Main DNS Hostname */}
            <motion.div
              whileHover={{ scale: 1.01 }}
              className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-2xl bg-zinc-950/80 border border-white/[0.08] text-xs font-mono text-zinc-200 shadow-inner max-w-full"
            >
              <Globe className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
              <span className="font-semibold select-all text-white truncate max-w-[200px] sm:max-w-none">
                {fullAddress}
              </span>
              <motion.button
                whileTap={{ scale: 0.88 }}
                onClick={handleCopyMain}
                title="Copy Server Address"
                className="ml-1 p-1 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-400 hover:text-white cursor-pointer shrink-0"
              >
                {copiedMain ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </motion.button>
            </motion.div>

            {/* Direct IP (Dynip) when online */}
            {state.dynip && state.status === 'online' && (
              <motion.div
                whileHover={{ scale: 1.01 }}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-2xl bg-emerald-950/30 border border-emerald-500/30 text-xs font-mono text-emerald-300 shadow-inner"
              >
                <Wifi className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="text-[11px] text-zinc-400 font-sans">Direct IP:</span>
                <span className="font-semibold select-all text-emerald-400">{state.dynip}</span>
                <motion.button
                  whileTap={{ scale: 0.88 }}
                  onClick={handleCopyDyn}
                  title="Copy Direct IP"
                  className="ml-1 p-1 hover:bg-emerald-900/50 rounded-lg transition-colors text-emerald-400 hover:text-white cursor-pointer shrink-0"
                >
                  {copiedDyn ? (
                    <Check className="w-3.5 h-3.5 text-emerald-300" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </motion.button>
              </motion.div>
            )}
          </div>
        </div>

        {/* Right column: Status Pill */}
        <div className="flex md:flex-col md:items-end justify-start md:justify-center shrink-0">
          <div
            className={`inline-flex items-center gap-2.5 px-4 sm:px-5 py-2.5 rounded-full text-xs font-mono font-bold tracking-wider transition-all select-none border shadow-md ${statusBadge.pillBg}`}
          >
            <span className="relative flex h-2.5 w-2.5">
              {statusBadge.isLive && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              )}
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${statusBadge.dotBg}`} />
            </span>
            <span>{statusBadge.label}</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
};
