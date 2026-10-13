import React, { useState, useRef, useEffect } from 'react';
import { motion } from 'motion/react';
import {
  Terminal,
  Copy,
  Check,
  Trash2,
  Search,
  Maximize2,
  Minimize2,
  Download,
  Send,
  Loader2,
} from 'lucide-react';
import type { LogEntry, LogLevel } from '../types/aternos.ts';

interface TerminalConsoleProps {
  logs: LogEntry[];
  onCopyNotice: () => void;
  onClearLogs: () => void;
  onCommandExecuted?: (cmd: string) => void;
}

export const TerminalConsole: React.FC<TerminalConsoleProps> = ({
  logs,
  onCopyNotice,
  onClearLogs,
  onCommandExecuted,
}) => {
  const [filter, setFilter] = useState<'ALL' | LogLevel>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [commandInput, setCommandInput] = useState('');
  const [isExecutingCommand, setIsExecutingCommand] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = logs.filter(entry => {
    const matchesLevel = filter === 'ALL' || entry.level === filter;
    const matchesSearch =
      !searchQuery ||
      entry.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entry.level.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entry.timestamp.includes(searchQuery);
    return matchesLevel && matchesSearch;
  });

  const handleCopyLogs = () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    onCopyNotice();
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadLogs = () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aternos-console-${new Date().toISOString().slice(0, 10)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSendCommand = async (cmdToSend?: string) => {
    const cmd = (cmdToSend !== undefined ? cmdToSend : commandInput).trim();
    if (!cmd || isExecutingCommand) return;

    setIsExecutingCommand(true);
    setCommandHistory(prev => [cmd, ...prev.filter(c => c !== cmd)]);
    setHistoryIndex(-1);
    setCommandInput('');

    try {
      const res = await fetch('/api/action/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      await res.json();
      if (onCommandExecuted) onCommandExecuted(cmd);
    } catch {
      // offline/proxy error
    } finally {
      setIsExecutingCommand(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSendCommand();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const nextIdx = Math.min(historyIndex + 1, commandHistory.length - 1);
        setHistoryIndex(nextIdx);
        setCommandInput(commandHistory[nextIdx]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const nextIdx = historyIndex - 1;
        setHistoryIndex(nextIdx);
        setCommandInput(commandHistory[nextIdx]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setCommandInput('');
      }
    }
  };

  const getBadgeStyle = (level: LogLevel) => {
    switch (level) {
      case 'SYS':
        return 'bg-zinc-800 text-zinc-300';
      case 'CMD':
        return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
      case 'INFO':
        return 'bg-zinc-900 text-zinc-400 border border-white/[0.06]';
      case 'WARN':
        return 'bg-amber-950/70 text-amber-300 border border-amber-800/60';
      case 'ERR':
        return 'bg-rose-950/70 text-rose-300 border border-rose-800/60';
      default:
        return 'bg-zinc-800 text-zinc-400';
    }
  };

  return (
    <div
      className={`bg-zinc-950/90 border border-white/[0.08] rounded-3xl shadow-2xl overflow-hidden flex flex-col transition-all duration-300 backdrop-blur-xl ${
        isExpanded ? 'h-[620px]' : 'h-[440px]'
      }`}
    >
      {/* Top Header */}
      <div className="bg-zinc-900/80 border-b border-white/[0.06] px-4 py-3 flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-700/80" />
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-700/80" />
            <span className="w-2.5 h-2.5 rounded-full bg-zinc-700/80" />
          </div>

          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-mono font-bold text-white uppercase tracking-wider">
              Aternos Live Console
            </span>
            <span className="text-[10px] font-mono text-zinc-400 bg-zinc-950/80 px-2 py-0.5 rounded-full border border-white/[0.06]">
              {logs.length} Lines
            </span>
          </div>
        </div>

        {/* Search Input */}
        <div className="relative flex items-center min-w-[140px] sm:min-w-[180px]">
          <Search className="w-3 h-3 text-zinc-500 absolute left-3 pointer-events-none" />
          <input
            type="text"
            placeholder="Search logs..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1 bg-zinc-950 border border-white/10 rounded-full text-xs font-mono text-white placeholder:text-zinc-600 focus:outline-none focus:border-white transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 text-zinc-500 hover:text-white text-xs font-mono"
            >
              ×
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-2.5 py-1 rounded-full text-[10px] font-mono transition-colors cursor-pointer border ${
              autoScroll
                ? 'bg-zinc-800 text-white border-white/20 font-bold'
                : 'bg-zinc-950 text-zinc-500 border-white/[0.06]'
            }`}
            title="Toggle Auto-Scroll"
          >
            Scroll: {autoScroll ? 'ON' : 'OFF'}
          </button>

          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={handleCopyLogs}
            title="Copy logs to clipboard"
            className="p-1.5 hover:bg-zinc-800 text-zinc-400 hover:text-white rounded-full transition-colors cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </motion.button>

          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={handleDownloadLogs}
            title="Download .log file"
            className="p-1.5 hover:bg-zinc-800 text-zinc-400 hover:text-white rounded-full transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
          </motion.button>

          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={onClearLogs}
            title="Clear terminal buffer"
            className="p-1.5 hover:bg-zinc-800 text-zinc-400 hover:text-white rounded-full transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </motion.button>

          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Collapse' : 'Expand Full Height'}
            className="p-1.5 hover:bg-zinc-800 text-zinc-400 hover:text-white rounded-full transition-colors cursor-pointer hidden sm:block"
          >
            {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </motion.button>
        </div>
      </div>

      {/* Filter Badges Sub-Bar */}
      <div className="bg-zinc-950/70 border-b border-white/[0.04] px-4 py-2 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
          <span className="text-[10px] font-mono text-zinc-400 mr-1 select-none">FILTER:</span>
          {(['ALL', 'SYS', 'CMD', 'INFO', 'WARN', 'ERR'] as const).map(lvl => (
            <motion.button
              key={lvl}
              whileTap={{ scale: 0.94 }}
              onClick={() => setFilter(lvl)}
              className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold transition-all cursor-pointer ${
                filter === lvl
                  ? 'bg-white text-zinc-950 shadow-sm'
                  : 'bg-zinc-900 text-zinc-400 hover:text-white border border-white/[0.06]'
              }`}
            >
              {lvl}
            </motion.button>
          ))}
        </div>

        {/* Quick Command Suggestions */}
        <div className="hidden md:flex items-center gap-1.5">
          <span className="text-[10px] font-mono text-zinc-400 mr-1 select-none">QUICK:</span>
          {['help', 'status', 'start', 'restart', 'extend', 'clear'].map(cmd => (
            <button
              key={cmd}
              onClick={() => handleSendCommand(cmd)}
              className="px-2 py-0.5 rounded-full text-[10px] font-mono text-zinc-300 hover:text-white bg-zinc-900 hover:bg-zinc-800 border border-white/10 cursor-pointer"
            >
              {cmd}
            </button>
          ))}
        </div>
      </div>

      {/* Terminal Viewport */}
      <div
        ref={scrollRef}
        className="flex-1 p-4 font-mono text-xs overflow-y-auto space-y-2 select-text bg-black/40"
      >
        {filteredLogs.length === 0 ? (
          <div className="text-zinc-600 italic text-center py-12 flex flex-col items-center gap-2">
            <Terminal className="w-6 h-6 opacity-40 text-zinc-500" />
            <span>
              {searchQuery ? `No logs matching "${searchQuery}"` : 'Awaiting server activity...'}
            </span>
          </div>
        ) : (
          filteredLogs.map(entry => (
            <div key={entry.id} className="flex items-start gap-2.5 py-0.5 leading-snug font-mono text-[11px] select-text">
              <span className="text-zinc-500 text-[10px] shrink-0 tabular-nums select-none pt-0.5">
                {entry.timestamp}
              </span>
              <span
                className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider shrink-0 ${getBadgeStyle(
                  entry.level
                )}`}
              >
                {entry.level}
              </span>
              <span className="text-zinc-300 break-words flex-1">{entry.message}</span>
            </div>
          ))
        )}
      </div>

      {/* Interactive Command Line Bar */}
      <div className="bg-zinc-900/90 border-t border-white/[0.06] px-3.5 py-2.5 flex items-center gap-2.5 shrink-0">
        <span className="text-emerald-400 font-mono font-black text-sm select-none pl-1">&gt;_</span>
        <input
          ref={inputRef}
          type="text"
          value={commandInput}
          onChange={e => setCommandInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isExecutingCommand}
          placeholder='Type a command (e.g. "status", "start", "restart", "extend", "help")...'
          className="flex-1 bg-zinc-950 border border-white/10 rounded-full px-3.5 py-1.5 text-xs font-mono text-white placeholder:text-zinc-600 focus:outline-none focus:border-white transition-colors"
        />
        <motion.button
          whileTap={{ scale: 0.94 }}
          onClick={() => handleSendCommand()}
          disabled={isExecutingCommand || !commandInput.trim()}
          className="px-4 py-1.5 rounded-full text-xs font-mono font-bold bg-white text-zinc-950 hover:bg-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center gap-1.5 shadow-sm"
        >
          {isExecutingCommand ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Send className="w-3.5 h-3.5" />
          )}
          <span className="hidden sm:inline">Exec</span>
        </motion.button>
      </div>
    </div>
  );
};
