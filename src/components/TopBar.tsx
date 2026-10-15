import React, { useState, useRef } from 'react';
import { motion } from 'motion/react';
import { Server, Layers, Sparkles, ShieldCheck } from 'lucide-react';

interface TopBarProps {
  onOpenSettings?: () => void;
  onOpenManageServers?: () => void;
  onTriggerAdmin?: () => void;
  isAdminLoggedIn?: boolean;
  onOpenAdminPanel?: () => void;
  activeServerName?: string;
  totalServersCount?: number;
  sessionConnected?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  onOpenManageServers,
  onTriggerAdmin,
  isAdminLoggedIn = false,
  onOpenAdminPanel,
  activeServerName = 'Minecraft Server',
  totalServersCount = 0,
  sessionConnected = false,
}) => {
  const [clickCount, setClickCount] = useState(0);
  const lastClickRef = useRef<number>(0);

  const handleServerIconClick = () => {
    const now = Date.now();
    let current = clickCount;

    // Reset if more than 3 seconds elapsed between clicks
    if (now - lastClickRef.current > 3000) {
      current = 1;
    } else {
      current = clickCount + 1;
    }

    lastClickRef.current = now;
    setClickCount(current);

    if (current >= 4) {
      setClickCount(0);
      if (isAdminLoggedIn && onOpenAdminPanel) {
        onOpenAdminPanel();
      } else if (onTriggerAdmin) {
        onTriggerAdmin();
      }
    }
  };

  return (
    <header className="sticky top-0 z-40 w-full bg-zinc-950/80 backdrop-blur-xl border-b border-white/[0.06] transition-all">
      <div className="max-w-6xl mx-auto px-3 sm:px-6 h-16 flex items-center justify-between gap-3">
        {/* Brand identity & Clickable Server Icon */}
        <div className="flex items-center gap-3 min-w-0 select-none">
          <div className="relative">
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.92 }}
              onClick={handleServerIconClick}
              title={isAdminLoggedIn ? 'Admin Active - Click to open Admin Panel' : 'Aternos Server Node'}
              className="w-10 h-10 rounded-2xl bg-gradient-to-br from-zinc-800 to-zinc-900 border border-white/10 flex items-center justify-center shadow-lg shadow-black/40 cursor-pointer active:border-emerald-500/50 transition-colors"
            >
              <Server className={`w-5 h-5 ${isAdminLoggedIn ? 'text-emerald-300' : 'text-emerald-400'}`} />
            </motion.div>
            {sessionConnected && (
              <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5 pointer-events-none">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500 border border-zinc-950" />
              </span>
            )}
          </div>

          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm sm:text-base font-extrabold tracking-tight text-white truncate font-sans">
                Apexion
              </span>
              <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold font-mono rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Sparkles className="w-2.5 h-2.5" /> 24/7 AFK
              </span>
              {isAdminLoggedIn && (
                <span
                  onClick={onOpenAdminPanel}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold font-mono rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 cursor-pointer hover:bg-emerald-500/30 transition-colors"
                >
                  <ShieldCheck className="w-2.5 h-2.5" /> Admin
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-400 truncate">
              <span className="truncate max-w-[140px] sm:max-w-[200px] text-zinc-300 font-medium">
                {activeServerName}
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-[11px] text-zinc-400">
                {totalServersCount} {totalServersCount === 1 ? 'server' : 'servers'}
              </span>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {isAdminLoggedIn && (
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => {
                if (onOpenAdminPanel) onOpenAdminPanel();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 transition-all cursor-pointer shadow-sm"
              title="Open Admin Command Center"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Admin Panel</span>
            </motion.button>
          )}

          {onOpenManageServers && (
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.95 }}
              onClick={onOpenManageServers}
              className="flex items-center gap-1.5 px-3 sm:px-3.5 py-1.5 sm:py-2 rounded-full text-xs font-medium text-zinc-300 hover:text-white bg-zinc-900/90 hover:bg-zinc-800 border border-white/10 hover:border-white/20 transition-all cursor-pointer shadow-sm"
              title="Manage Server Profiles"
            >
              <Layers className="w-3.5 h-3.5 text-zinc-400" />
              <span>Profiles</span>
            </motion.button>
          )}
        </div>
      </div>
    </header>
  );
};
