import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertCircle, CheckCircle2, Info, X, Layers, AlertTriangle } from 'lucide-react';

export interface ToastMessage {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const ToastContainer: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  const [isHovered, setIsHovered] = useState(false);

  if (toasts.length === 0) return null;

  // We show up to the latest 3 toasts in the folded deck
  const visibleToasts = toasts.slice(-3);
  const totalCount = toasts.length;

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="fixed bottom-20 md:bottom-6 right-3 sm:right-6 z-50 max-w-[340px] w-full pointer-events-none select-none"
    >
      <div className="relative w-full h-[64px]">
        <AnimatePresence>
          {visibleToasts.map((toast, index) => {
            // Reverse index: 0 is the newest (top-most card)
            const reverseIndex = visibleToasts.length - 1 - index;

            // Folded card-stack geometry
            // 0 (top): y=0, scale=1
            // 1 (behind): y=-10, scale=0.96
            // 2 (deepest): y=-20, scale=0.92
            // On hover: slightly expands for clear visibility
            const translateY = isHovered
              ? -reverseIndex * 48
              : -reverseIndex * 10;

            const scale = isHovered
              ? 1 - reverseIndex * 0.02
              : 1 - reverseIndex * 0.04;

            const opacity = isHovered
              ? 1 - reverseIndex * 0.1
              : 1 - reverseIndex * 0.2;

            const zIndex = 50 - reverseIndex;

            const typeStyles = {
              success: {
                icon: <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />,
                border: 'border-emerald-500/30',
                glow: 'shadow-emerald-500/10',
              },
              error: {
                icon: <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />,
                border: 'border-rose-500/30',
                glow: 'shadow-rose-500/10',
              },
              warning: {
                icon: <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />,
                border: 'border-amber-500/30',
                glow: 'shadow-amber-500/10',
              },
              info: {
                icon: <Info className="w-4 h-4 text-sky-400 shrink-0" />,
                border: 'border-white/15',
                glow: 'shadow-sky-500/10',
              },
            }[toast.type];

            return (
              <motion.div
                key={toast.id}
                initial={{ opacity: 0, y: 16, scale: 0.92 }}
                animate={{
                  opacity,
                  y: translateY,
                  scale,
                }}
                exit={{
                  opacity: 0,
                  scale: 0.9,
                  y: 10,
                  transition: { duration: 0.18, ease: 'easeOut' },
                }}
                transition={{
                  type: 'spring',
                  stiffness: 380,
                  damping: 28,
                  mass: 0.6,
                }}
                style={{
                  zIndex,
                  willChange: 'transform, opacity',
                  transformOrigin: 'bottom center',
                }}
                className={`absolute bottom-0 left-0 right-0 pointer-events-auto flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-zinc-950/95 border backdrop-blur-md text-white shadow-xl transition-colors ${typeStyles.border} ${typeStyles.glow}`}
              >
                {/* Icon & Message */}
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  {typeStyles.icon}
                  <p className="text-xs font-mono font-medium leading-snug truncate text-zinc-100">
                    {toast.message}
                  </p>
                </div>

                {/* Right controls: stack badge & dismiss */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {reverseIndex === 0 && totalCount > 1 && (
                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-zinc-800 text-zinc-300 border border-white/10 shadow-sm">
                      <Layers className="w-2.5 h-2.5 text-zinc-400" />
                      +{totalCount - 1}
                    </span>
                  )}

                  <button
                    onClick={e => {
                      e.stopPropagation();
                      onDismiss(toast.id);
                    }}
                    className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                    title="Dismiss"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
};
