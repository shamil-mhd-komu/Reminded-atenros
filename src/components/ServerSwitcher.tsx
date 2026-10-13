import React from 'react';
import { motion } from 'motion/react';
import { Plus, SlidersHorizontal, CheckCircle2 } from 'lucide-react';
import type { ServerProfile, ServerStatus, AternosState } from '../types/aternos.ts';

interface ServerSwitcherProps {
  servers: ServerProfile[];
  activeServerId: string;
  activeStatus: ServerStatus;
  serverStates?: Record<string, AternosState>;
  onSelectServer: (id: string) => void;
  onOpenManageServers: () => void;
  onQuickAddServer: () => void;
}

export const ServerSwitcher: React.FC<ServerSwitcherProps> = ({
  servers,
  activeServerId,
  activeStatus,
  serverStates = {},
  onSelectServer,
  onOpenManageServers,
  onQuickAddServer,
}) => {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-zinc-900/50 border border-white/[0.08] rounded-3xl p-2.5 sm:px-4 sm:py-3 backdrop-blur-xl shadow-lg shadow-black/20">
      {/* Horizontal Scrollable Server List */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-0.5">
        <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 shrink-0 mr-1 hidden sm:inline select-none">
          Profiles:
        </span>

        {servers.length === 0 && (
          <span className="text-xs font-mono text-zinc-400 italic px-1">
            No servers connected
          </span>
        )}

        {servers.map(server => {
          const isActive = server.id === activeServerId;
          const profileState =
            serverStates[server.id] ||
            serverStates[server.serverIp.toLowerCase()] ||
            serverStates[server.name.toLowerCase()];
          const status: ServerStatus =
            profileState?.status || (isActive ? activeStatus : (server.status || 'offline'));
          const isOnline = status === 'online';
          const isStarting = status === 'starting' || status === 'loading';
          const isQueue = status === 'queue';
          const countdown = profileState?.countdownFormatted || server.countdownFormatted;

          let statusLabel = 'Offline';
          let dotColor = 'bg-zinc-600';
          let textColor = 'text-zinc-400';

          if (isOnline) {
            statusLabel = countdown ? countdown : 'Online';
            dotColor = 'bg-emerald-400';
            textColor = 'text-emerald-400 font-semibold';
          } else if (isStarting) {
            statusLabel = 'Booting';
            dotColor = 'bg-amber-400 animate-pulse';
            textColor = 'text-amber-400 font-medium';
          } else if (isQueue) {
            statusLabel = 'Queue';
            dotColor = 'bg-blue-400';
            textColor = 'text-blue-400 font-medium';
          }

          return (
            <motion.button
              key={server.id}
              whileTap={{ scale: 0.96 }}
              whileHover={{ scale: 1.01 }}
              onClick={() => onSelectServer(server.id)}
              className={`relative flex items-center gap-2.5 px-3.5 py-2 rounded-full text-xs transition-all whitespace-nowrap cursor-pointer shrink-0 border ${
                isActive
                  ? 'bg-zinc-800 text-white font-semibold border-white/20 shadow-md ring-1 ring-white/10'
                  : 'bg-zinc-950/70 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 border-white/[0.06]'
              }`}
            >
              <span className="relative flex h-2 w-2 shrink-0">
                {isOnline && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                )}
                <span className={`relative inline-flex rounded-full h-2 w-2 ${dotColor}`} />
              </span>

              <span className="max-w-[130px] sm:max-w-[170px] truncate font-sans">
                {server.name}
              </span>

              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-black/40 ${textColor}`}>
                {statusLabel}
              </span>
            </motion.button>
          );
        })}

        <motion.button
          whileTap={{ scale: 0.95 }}
          whileHover={{ scale: 1.02 }}
          onClick={onQuickAddServer}
          className="flex items-center gap-1 px-3 py-2 rounded-full text-xs font-mono text-zinc-400 hover:text-white bg-zinc-950/60 hover:bg-zinc-900 border border-dashed border-white/15 hover:border-white/30 transition-all cursor-pointer shrink-0"
          title="Add new Minecraft server"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New</span>
        </motion.button>
      </div>

      {/* Action to manage profiles */}
      <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
        <motion.button
          whileTap={{ scale: 0.95 }}
          whileHover={{ scale: 1.02 }}
          onClick={onOpenManageServers}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-mono text-zinc-300 hover:text-white bg-zinc-900 hover:bg-zinc-800 border border-white/10 hover:border-white/20 transition-all cursor-pointer shadow-sm"
          title="Manage all server configurations"
        >
          <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-400" />
          <span>Manage ({servers.length})</span>
        </motion.button>
      </div>
    </div>
  );
};
