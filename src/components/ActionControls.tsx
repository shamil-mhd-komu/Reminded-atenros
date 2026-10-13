import React from 'react';
import { motion } from 'motion/react';
import { Play, Square, RotateCw, Plus, Loader2 } from 'lucide-react';
import type { AternosState } from '../types/aternos.ts';

interface ActionControlsProps {
  state: AternosState;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onExtend?: () => void;
  isLoading: boolean;
}

export const ActionControls: React.FC<ActionControlsProps> = ({
  state,
  onStart,
  onStop,
  onRestart,
  onExtend,
  isLoading,
}) => {
  const isOnline = state.status === 'online';
  const isStarting = state.status === 'starting' || state.status === 'loading';
  const isQueue = state.status === 'queue';
  const isStopping = state.status === 'stopping';
  const isOffline = state.status === 'offline';

  const hasPlayers = (state.playersOnline ?? 0) > 0;

  const startDisabled = isLoading || isOnline || isStarting || isQueue;
  const startLabel = isStarting ? 'Starting...' : isQueue ? 'In Queue' : 'Start';

  const stopDisabled = isLoading || isStopping || isOffline;
  const stopLabel = isStopping ? 'Stopping...' : 'Stop';

  const restartDisabled = isLoading || isStarting || isStopping || isOffline;
  const extendDisabled = isLoading || !isOnline || hasPlayers;

  return (
    <div className="bg-zinc-900/60 border border-white/[0.08] rounded-3xl p-5 sm:p-7 shadow-xl backdrop-blur-xl">
      <div className="flex items-center justify-between mb-5 border-b border-white/[0.06] pb-4">
        <div>
          <h3 className="text-base sm:text-lg font-bold text-white tracking-tight font-sans">
            Server Controls
          </h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            Direct AJAX server triggers with live status feedback
          </p>
        </div>
        <div className="hidden sm:flex items-center gap-2">
          <span className="text-[11px] font-mono text-zinc-400 uppercase tracking-widest px-2.5 py-1 rounded-full bg-zinc-950/60 border border-white/[0.06]">
            {state.status.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Responsive 2x2 grid on mobile, 4-column on desktop - Guaranteed no overflow */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Start Button */}
        <motion.button
          whileHover={!startDisabled ? { scale: 1.02 } : {}}
          whileTap={!startDisabled ? { scale: 0.96 } : {}}
          onClick={onStart}
          disabled={startDisabled}
          className={`relative flex items-center justify-center gap-2 px-3 sm:px-4 py-3.5 rounded-2xl font-bold text-xs sm:text-sm tracking-wide transition-all shadow-md overflow-hidden ${
            startDisabled
              ? 'bg-zinc-950/60 text-zinc-600 border border-white/[0.04] cursor-not-allowed opacity-50'
              : 'bg-emerald-500 hover:bg-emerald-400 text-zinc-950 border border-emerald-400/30 shadow-emerald-500/20 shadow-lg cursor-pointer'
          }`}
          title={isOnline ? 'Server is already running' : 'Start server on Aternos'}
        >
          {isLoading && state.currentAction === 'start' ? (
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          ) : (
            <Play className={`w-4 h-4 shrink-0 ${!startDisabled ? 'fill-current' : ''}`} />
          )}
          <span className="truncate">{startLabel}</span>
        </motion.button>

        {/* Stop Button */}
        <motion.button
          whileHover={!stopDisabled ? { scale: 1.02 } : {}}
          whileTap={!stopDisabled ? { scale: 0.96 } : {}}
          onClick={onStop}
          disabled={stopDisabled}
          className={`flex items-center justify-center gap-2 px-3 sm:px-4 py-3.5 rounded-2xl font-bold text-xs sm:text-sm tracking-wide transition-all shadow-md overflow-hidden ${
            stopDisabled
              ? 'bg-zinc-950/60 text-zinc-600 border border-white/[0.04] cursor-not-allowed opacity-50'
              : 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 shadow-rose-500/10 shadow-lg cursor-pointer'
          }`}
          title={isOffline ? 'Server is offline' : 'Stop Minecraft server'}
        >
          {isLoading && state.currentAction === 'stop' ? (
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          ) : (
            <Square className="w-4 h-4 fill-current shrink-0" />
          )}
          <span className="truncate">{stopLabel}</span>
        </motion.button>

        {/* Restart Button */}
        <motion.button
          whileHover={!restartDisabled ? { scale: 1.02 } : {}}
          whileTap={!restartDisabled ? { scale: 0.96 } : {}}
          onClick={onRestart}
          disabled={restartDisabled}
          className={`flex items-center justify-center gap-2 px-3 sm:px-4 py-3.5 rounded-2xl font-bold text-xs sm:text-sm tracking-wide transition-all shadow-md overflow-hidden ${
            restartDisabled
              ? 'bg-zinc-950/60 text-zinc-600 border border-white/[0.04] cursor-not-allowed opacity-50'
              : 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 shadow-amber-500/10 shadow-lg cursor-pointer'
          }`}
          title={isOffline ? 'Server must be online to restart' : 'Reboot server'}
        >
          {isLoading && state.currentAction === 'restart' ? (
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          ) : (
            <RotateCw className="w-4 h-4 shrink-0" />
          )}
          <span className="truncate">Restart</span>
        </motion.button>

        {/* Extend Keepalive Button */}
        <motion.button
          whileHover={!extendDisabled ? { scale: 1.02 } : {}}
          whileTap={!extendDisabled ? { scale: 0.96 } : {}}
          onClick={onExtend}
          disabled={extendDisabled}
          className={`flex items-center justify-center gap-2 px-3 sm:px-4 py-3.5 rounded-2xl font-bold text-xs sm:text-sm tracking-wide transition-all shadow-md overflow-hidden ${
            extendDisabled
              ? 'bg-zinc-950/60 text-zinc-600 border border-white/[0.04] cursor-not-allowed opacity-50'
              : 'bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/30 shadow-sky-500/10 shadow-lg cursor-pointer'
          }`}
          title={
            hasPlayers
              ? `Timer paused (${state.playersOnline} player${(state.playersOnline ?? 0) > 1 ? 's' : ''} online). Server remains running automatically.`
              : state.countdownSeconds !== null && state.countdownSeconds > 60
              ? 'Aternos only allows +1 when timer drops below 1:00'
              : 'Add +1 Minute Keepalive Timer'
          }
        >
          {isLoading && state.currentAction === 'extend' ? (
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          ) : (
            <Plus className="w-4 h-4 stroke-[3] shrink-0" />
          )}
          <span className="truncate">
            {hasPlayers ? 'Timer Paused' : '+1 Min'}
          </span>
        </motion.button>
      </div>
    </div>
  );
};
