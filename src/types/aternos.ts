export type ServerStatus =
  | 'online'
  | 'starting'
  | 'queue'
  | 'stopping'
  | 'offline'
  | 'loading'
  | 'unknown';

export type LogLevel = 'SYS' | 'INFO' | 'CMD' | 'WARN' | 'ERR';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface AternosState {
  status: ServerStatus;
  rawStatus: string;
  serverIp: string;
  serverPort: string;
  software: string;
  version: string;
  playersOnline?: number;
  maxPlayers?: number;
  playerList?: string[];
  motd?: string;
  queuePosition: number | null;
  queueEta: string | null;
  countdownSeconds: number | null;
  countdownFormatted: string | null;
  countdownActive: boolean;
  canExtend: boolean;
  startVisible: boolean;
  stopVisible: boolean;
  restartVisible: boolean;
  extendVisible: boolean;
  lastUpdated: number;
  isActionPending: boolean;
  currentAction: string | null;
  sessionConnected: boolean;
  sessionError?: string | null;
  cloudflareBlocked?: boolean;
  dynip?: string;
  allServerStates?: Record<string, AternosState>;
}

export interface SessionConfig {
  sessionCookie: string;
  serverCookie: string;
  serverAddress: string;
  cfClearanceCookie?: string;
  userAgent?: string;
  name?: string;
  software?: string;
  version?: string;
  serverPort?: string;
}

export interface ServerProfile {
  id: string;
  name: string;
  serverIp: string;
  serverPort: string;
  software: string;
  version: string;
  sessionCookie: string;
  serverCookie: string;
  cfClearanceCookie?: string;
  userAgent?: string;
  lastActive?: number;
  macros?: MacroRule[];
  status?: ServerStatus;
  countdownFormatted?: string | null;
  playersOnline?: number;
  maxPlayers?: number;
}

export interface MacroRule {
  id: string;
  name: string;
  description: string;
  type: 'restart_interval' | 'restart_daily' | 'extend_interval' | 'afk_watchdog';
  enabled: boolean;
  // Interval in minutes (e.g., 300 for 5 hours, 4 for 4 minutes)
  intervalMinutes?: number;
  // Daily time in 24h format "HH:MM" (e.g., "06:30")
  dailyTime?: string;
  // Randomized threshold in seconds for keepalive extend (triggers when countdown <= this, e.g. 58s or 56s)
  randomTriggerSec?: number;
  targetMinSec?: number;
  targetMaxSec?: number;
  lastRunTimestamp: number | null;
  nextRunTimestamp: number | null;
  runCount: number;
}
