import React from 'react';
import { motion } from 'motion/react';
import { Play, Square, RotateCw, Plus, Loader2 } from 'lucide-react';
import type { AternosState } from '../types/aternos.ts';

interface MobileTouchBarProps {
  state: AternosState;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onExtend: () => void;
  isLoading: boolean;
}

export const MobileTouchBar: React.FC<MobileTouchBarProps> = ({
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

  const showKeepalive = isOnline;
  const isReadyToExtend = showKeepalive && (state.countdownSeconds || 0) <= 60;
  const startDisabled = isLoading || isOnline || isStarting || isQueue;
  const stopDisabled = isLoading || isStopping || isOffline;
  const restartDisabled = isLoading || isStarting || isStopping || isOffline;

  const hasPlayers = (state.playersOnline ?? 0) > 0;
  const extendDisabled = isLoading || hasPlayers;

  return (
    <div className="md:hidden fixed bottom-4 left-3 right-3 z-40 max-w-sm mx-auto pointer-events-auto">
      <div className="bg-zinc-950/90 backdrop-blur-2xl border border-white/15 rounded-full p-1.5 shadow-2xl shadow-black/80 flex items-center justify-between gap-1.5 ring-1 ring-white/10">
        {/* Start Button */}
        <motion.button
          whileTap={!startDisabled ? { scale: 0.92 } : {}}
          onClick={onStart}
          disabled={startDisabled}
          className={`flex-1 min-h-[44px] flex items-center justify-center gap-1.5 rounded-full font-bold text-xs transition-all cursor-pointer ${
            startDisabled
              ? 'bg-zinc-900/60 text-zinc-600 border border-white/[0.04] cursor-not-allowed opacity-50'
              : 'bg-emerald-500 text-zinc-950 font-bold shadow-lg shadow-emerald-500/20'
          }`}
        >
          {isLoading && state.currentAction === 'start' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className={`w-3.5 h-3.5 ${!startDisabled ? 'fill-current' : ''}`} />
          )}
          <span className="truncate">{isStarting ? 'Booting' : isQueue ? 'Queue' : 'Start'}</span>
        </motion.button>

        {/* Stop Button */}
        <motion.button
          whileTap={!stopDisabled ? { scale: 0.92 } : {}}
          onClick={onStop}
          disabled={stopDisabled}
          className={`flex-1 min-h-[44px] flex items-center justify-center gap-1.5 rounded-full font-bold text-xs transition-all cursor-pointer ${
            stopDisabled
              ? 'bg-zinc-900/60 text-zinc-600 border border-white/[0.04] cursor-not-allowed opacity-50'
              : 'bg-rose-500/20 text-rose-300 border border-rose-500/30 active:bg-rose-500/30'
          }`}
        >
          {isLoading && state.currentAction === 'stop' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Square className="w-3.5 h-3.5 fill-current" />
          )}
          <span className="truncate">{isStopping ? 'Halting' : 'Stop'}</span>
        </motion.button>

        {/* Restart Button */}
        <motion.button
          whileTap={!restartDisabled ? { scale: 0.92 } : {}}
          onClick={onRestart}
          disabled={restartDisabled}
          className={`flex-1 min-h-[44px] flex items-center justify-center gap-1.5 rounded-full font-bold text-xs transition-all cursor-pointer ${
            restartDisabled
              ? 'bg-zinc-900/60 text-zinc-600 border border-white/[0.04] cursor-not-allowed opacity-50'
              : 'bg-amber-500/20 text-amber-300 border border-amber-500/30 active:bg-amber-500/30'
          }`}
        >
          {isLoading && state.currentAction === 'restart' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RotateCw className="w-3.5 h-3.5" />
          )}
          <span className="truncate">Reboot</span>
        </motion.button>

        {/* Extend Keepalive Button */}
        {showKeepalive && (
          <motion.button
            whileTap={!extendDisabled ? { scale: 0.92 } : {}}
            onClick={onExtend}
            disabled={extendDisabled}
            className={`min-h-[44px] px-3.5 flex items-center justify-center gap-1 rounded-full font-bold text-xs transition-all ${
              extendDisabled
                ? 'bg-zinc-900/60 text-zinc-600 border border-white/[0.04] cursor-not-allowed opacity-50'
                : 'bg-white text-zinc-950 active:bg-zinc-200 shadow-md cursor-pointer'
            } ${
              isReadyToExtend && !extendDisabled ? 'ring-2 ring-amber-400 animate-pulse' : ''
            }`}
            title={hasPlayers ? 'Timer is paused while players are connected' : 'Extend keepalive timer'}
          >
            <Plus className="w-3.5 h-3.5 stroke-[3]" />
            <span>{hasPlayers ? 'Paused' : '+1m'}</span>
          </motion.button>
        )}
      </div>
    </div>
  );
};
