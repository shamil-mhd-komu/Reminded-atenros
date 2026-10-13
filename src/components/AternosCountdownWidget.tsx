import React from 'react';
import { motion } from 'motion/react';
import { Clock, Plus, Loader2, Users } from 'lucide-react';
import type { ServerStatus } from '../types/aternos.ts';

interface AternosCountdownWidgetProps {
  serverStatus: ServerStatus;
  countdownActive: boolean;
  countdownSeconds: number | null;
  countdownFormatted: string | null;
  playersOnline?: number;
  onExtend: () => void;
  isExtending: boolean;
}

export const AternosCountdownWidget: React.FC<AternosCountdownWidgetProps> = ({
  serverStatus,
  countdownActive,
  countdownSeconds,
  countdownFormatted,
  playersOnline = 0,
  onExtend,
  isExtending,
}) => {
  if (
    serverStatus !== 'online' ||
    !countdownActive ||
    countdownSeconds === null ||
    countdownSeconds <= 0
  ) {
    return null;
  }

  const hasPlayers = playersOnline > 0;
  const isReady = countdownSeconds <= 60 && countdownSeconds > 0 && !hasPlayers;
  const mins = Math.floor(countdownSeconds / 60);
  const secs = countdownSeconds % 60;
  const displayTime = countdownFormatted || `${mins}:${secs < 10 ? '0' : ''}${secs}`;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="flex flex-col items-center gap-2"
    >
      <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono">
        <span>Aternos Keepalive Timer</span>
        <span aria-hidden="true">·</span>
        {hasPlayers ? (
          <span className="text-emerald-400 font-semibold flex items-center gap-1">
            <Users className="w-3 h-3" /> Paused ({playersOnline} Active)
          </span>
        ) : (
          <span className={isReady ? 'text-amber-400 font-semibold animate-pulse' : 'text-zinc-500'}>
            {isReady ? 'Critical (≤ 1:00)' : 'AFK Active'}
          </span>
        )}
      </div>

      <div className="bg-zinc-900/90 text-white rounded-full px-5 py-2.5 shadow-2xl border border-white/[0.08] flex items-center gap-4 backdrop-blur-xl">
        <div className="flex items-center gap-2.5">
          <Clock className={`w-4 h-4 ${hasPlayers ? 'text-emerald-400' : isReady ? 'text-amber-400 animate-spin' : 'text-zinc-400'} shrink-0`} />
          <span className="font-mono text-lg font-bold tabular-nums tracking-widest text-white select-none">
            {displayTime}
          </span>
        </div>

        <motion.button
          whileHover={!hasPlayers ? { scale: 1.05 } : {}}
          whileTap={!hasPlayers ? { scale: 0.95 } : {}}
          onClick={onExtend}
          disabled={isExtending || countdownSeconds <= 0 || hasPlayers}
          title={
            hasPlayers
              ? `Timer paused (${playersOnline} players online). Server remains active automatically.`
              : 'Extend server countdown by +1 minute'
          }
          className={`relative inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold tracking-wider transition-all shadow-lg ${
            hasPlayers
              ? 'bg-zinc-800 text-zinc-500 border border-white/5 opacity-50 cursor-not-allowed'
              : isReady
              ? 'bg-amber-400 hover:bg-amber-300 text-zinc-950 ring-2 ring-amber-400/50 cursor-pointer'
              : 'bg-white hover:bg-zinc-200 text-zinc-950 cursor-pointer'
          } ${countdownSeconds <= 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
        >
          {isExtending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Plus className="w-3.5 h-3.5 stroke-[3]" />
          )}
          <span>{hasPlayers ? 'PAUSED' : '+1 MIN'}</span>
          {isReady && !hasPlayers && (
            <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-300" />
            </span>
          )}
        </motion.button>
      </div>
    </motion.div>
  );
};
