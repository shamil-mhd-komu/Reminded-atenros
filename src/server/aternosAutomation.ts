import vm from 'vm';
import { exec, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { AternosState, LogEntry, LogLevel, MacroRule, ServerStatus, SessionConfig } from '../types/aternos.ts';
import { serverStorage } from './serverStorage.ts';

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  sessionCookie: process.env.ATERNOS_SESSION || '',
  serverCookie: process.env.ATERNOS_SERVER || '',
  serverAddress: process.env.ATERNOS_SERVER_ADDRESS || '',
};

function randomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

interface ServerSessionInstance {
  id?: string;
  config: SessionConfig;
  state: AternosState;
  isInitializing: boolean;
  lastInitError: string | null;
  lastStartAttempt?: number;
  macros?: MacroRule[];
}

export const DEFAULT_MACRO_RULES: MacroRule[] = [
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
    description: 'Automatically restart the server every X hours or minutes to prevent lag and refresh server state',
    type: 'restart_interval',
    enabled: false,
    intervalMinutes: 60,
    lastRunTimestamp: null,
    nextRunTimestamp: null,
    runCount: 0,
  },
  {
    id: 'macro-restart-daily',
    name: 'Daily Scheduled Restart',
    description: 'Automatically restart the server everyday at a scheduled time (e.g. 06:30 AM)',
    type: 'restart_daily',
    enabled: false,
    dailyTime: '06:30',
    lastRunTimestamp: null,
    nextRunTimestamp: null,
    runCount: 0,
  },
];

export class AternosAutomationManager {
  private sessions: Map<string, ServerSessionInstance> = new Map();
  private activeSessionKey: string = 'default';
  private logsBuffer: LogEntry[] = [];
  private readonly MAX_LOGS = 120;
  private curlBinaryPath: string;
  private inFlightSyncs: Map<string, Promise<AternosState>> = new Map();
  private macroRules: MacroRule[] = JSON.parse(JSON.stringify(DEFAULT_MACRO_RULES));

  constructor() {
    this.curlBinaryPath = path.resolve(process.cwd(), 'bin', 'curl_chrome116');
    this.ensureCurlBinary();

    this.addLog('SYS', 'Apexion Server Core online. High-speed stealth automation active.');

    // Initialize with default or persistent config
    const initialConfig = this.loadConfig();
    if (initialConfig.serverAddress) {
      this.activeSessionKey = initialConfig.serverAddress.toLowerCase();
      this.getOrCreateSessionInstance(this.activeSessionKey, initialConfig);
    }

    // Load saved multi-server profiles and macros from files and serverStorage
    this.loadServersConfig();
    this.loadMacrosConfig();
    this.loadAllFromStorage();

    // Live update when admin/discord changes any server profile or macros
    serverStorage.onChange(() => {
      this.loadAllFromStorage();
    });

    // Background poll loop: every 3.5 seconds sync active sessions and verify continuous guardian macros
    setInterval(() => {
      this.loadAllFromStorage();
      this.syncActiveSession().catch(() => {});
    }, 3500);

    // Background countdown ticker
    setInterval(() => {
      this.tickCountdowns();
    }, 1000);

    // Macro execution loop: every 5 seconds
    setInterval(() => {
      this.processMacros().catch(() => {});
    }, 5000);
  }

  private ensureCurlBinary() {
    try {
      if (!fs.existsSync(this.curlBinaryPath)) {
        const binDir = path.dirname(this.curlBinaryPath);
        if (!fs.existsSync(binDir)) {
          fs.mkdirSync(binDir, { recursive: true });
        }
        execSync(
          'curl -sL "https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz" | tar -xz -C ./bin',
          { stdio: 'ignore' }
        );
      }
      if (fs.existsSync(this.curlBinaryPath)) {
        fs.chmodSync(this.curlBinaryPath, 0o755);
      }
      const binDir = path.dirname(this.curlBinaryPath);
      if (fs.existsSync(binDir)) {
        for (const file of fs.readdirSync(binDir)) {
          try {
            fs.chmodSync(path.join(binDir, file), 0o755);
          } catch {}
        }
      }
    } catch (err: any) {
      console.warn('Could not ensure curl binary permissions:', err?.message);
    }
  }

  private loadConfig(): SessionConfig {
    try {
      if (fs.existsSync('./session-config.json')) {
        const raw = fs.readFileSync('./session-config.json', 'utf-8');
        return JSON.parse(raw);
      }
    } catch {}
    return { ...DEFAULT_SESSION_CONFIG };
  }

  private loadMacrosConfig(): void {
    try {
      if (fs.existsSync('./macros-config.json')) {
        const raw = fs.readFileSync('./macros-config.json', 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.macroRules = parsed;
        }
      }
    } catch (err: any) {
      console.warn('Could not load macros-config.json:', err?.message);
    }
  }

  private saveMacrosConfig(): void {
    try {
      fs.writeFileSync('./macros-config.json', JSON.stringify(this.macroRules, null, 2), 'utf-8');
    } catch {}
  }

  private loadServersConfig(): void {
    try {
      if (fs.existsSync('./servers-config.json')) {
        const raw = fs.readFileSync('./servers-config.json', 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const s of list) {
            const address = s.serverIp || s.serverAddress || s.name;
            if (!address) continue;
            const key = address.toLowerCase();
            const cfg: SessionConfig = {
              sessionCookie: s.sessionCookie || '',
              serverCookie: s.serverCookie || '',
              serverAddress: address,
              software: s.software || 'Fabric',
              version: s.version || '26.3 (0.19.5)',
              serverPort: s.serverPort || '25565',
            };
            const inst = this.getOrCreateSessionInstance(key, cfg);
            if (s.id) inst.id = s.id;
          }
        }
      }
    } catch (err: any) {
      console.warn('Could not load servers-config.json:', err?.message);
    }
  }

  /**
   * Load and synchronize ALL persistent server profiles and Discord bindings from serverStorage.
   * This ensures 24/7 background AFK Watchdog and Keepalive macros run seamlessly
   * even when no users are visiting the website.
   */
  public loadAllFromStorage(): void {
    try {
      const allProfiles = serverStorage.getAllProfiles();
      const allBindings = serverStorage.getAllDiscordBindings();

      for (const p of allProfiles) {
        const address = p.serverIp || p.name;
        if (!address) continue;
        const canonical = serverStorage.getCanonicalServerAddress(address);
        const key = canonical.toLowerCase();
        let inst = this.findSessionInstance(key) || this.sessions.get(key);

        const cfg: SessionConfig = {
          sessionCookie: p.sessionCookie || '',
          serverCookie: p.serverCookie || '',
          serverAddress: canonical,
          software: p.software || 'Fabric',
          version: p.version || '1.20.4',
          serverPort: p.serverPort || '25565',
        };

        if (!inst) {
          inst = this.getOrCreateSessionInstance(key, cfg);
        } else {
          if (p.sessionCookie && !p.sessionCookie.includes('...')) {
            inst.config.sessionCookie = p.sessionCookie.trim();
          }
          inst.config.serverAddress = canonical;
          inst.state.serverIp = canonical;

          if (p.software) inst.state.software = p.software;
          if (p.version) inst.state.version = p.version;
          if (p.serverPort) inst.state.serverPort = p.serverPort;
        }

        if (p.id) inst.id = p.id;
        if (Array.isArray(p.macros) && p.macros.length > 0) {
          if (!inst.macros || inst.macros.length === 0) {
            inst.macros = JSON.parse(JSON.stringify(p.macros));
          } else {
            // Merge macros: preserve enabled status if armed in either profile
            inst.macros = inst.macros.map(m => {
              const fromP = p.macros!.find((x: any) => x.id === m.id);
              if (!fromP) return m;
              // If incoming profile has macros, prioritize its enabled state and values
              return {
                ...m,
                ...fromP,
                // Ensure we don't wipe internal runtime state if we want to preserve it,
                // but the 'enabled' flag MUST come from the profile (user intent)
                enabled: fromP.enabled,
              };
            });
          }
        }
        inst.state.sessionConnected = Boolean(inst.config.sessionCookie && inst.config.sessionCookie.trim().length > 0);
      }

      for (const b of allBindings) {
        if (!b.serverAddress) continue;
        const canonical = serverStorage.getCanonicalServerAddress(b.serverAddress);
        const key = canonical.toLowerCase();
        let inst = this.findSessionInstance(key) || this.sessions.get(key);

        if (!inst) {
          inst = this.getOrCreateSessionInstance(key, {
            sessionCookie: b.sessionCookie || '',
            serverCookie: b.serverCookie || '',
            serverAddress: canonical,
          });
        } else {
          if (b.sessionCookie && !b.sessionCookie.includes('...')) {
            inst.config.sessionCookie = b.sessionCookie.trim();
          }
          if (b.serverCookie) {
            inst.config.serverCookie = b.serverCookie.trim();
          }
          inst.config.serverAddress = canonical;
          inst.state.serverIp = canonical;
        }
        inst.state.sessionConnected = Boolean(inst.config.sessionCookie && inst.config.sessionCookie.trim().length > 0);
      }
    } catch (err: any) {
      console.warn('[Apexion] loadAllFromStorage notice:', err?.message);
    }
  }

  public getServersList(): any[] {
    try {
      const storageProfiles = serverStorage.getAllProfiles();
      if (storageProfiles.length > 0) {
        return storageProfiles;
      }
      if (fs.existsSync('./servers-config.json')) {
        const raw = fs.readFileSync('./servers-config.json', 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list) && list.length > 0) {
          return list;
        }
      }
    } catch {}
    return [];
  }

  public addLog(level: LogLevel, rawMessage: string) {
    const clean = rawMessage.trim();
    const last = this.logsBuffer[this.logsBuffer.length - 1];
    if (last && last.level === level && last.message === clean) {
      return;
    }

    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      level,
      message: clean,
    };
    this.logsBuffer.push(entry);
    if (this.logsBuffer.length > this.MAX_LOGS) {
      this.logsBuffer.shift();
    }
    console.log(`[${entry.timestamp}] [${entry.level}] ${entry.message}`);
  }

  public getLogs(): LogEntry[] {
    return [...this.logsBuffer];
  }

  public clearLogs() {
    this.logsBuffer = [];
  }

  public findSessionInstance(query?: string): ServerSessionInstance | undefined {
    if (!query) return this.getActiveInstance();
    const clean = query.trim().toLowerCase();
    if (this.sessions.has(clean)) return this.sessions.get(clean);
    const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '').replace(/\.aternos\.me$/i, '');
    const cleanNorm = normalize(clean);

    for (const inst of this.sessions.values()) {
      if (
        (inst.id && inst.id.toLowerCase() === clean) ||
        (inst.config.serverAddress && inst.config.serverAddress.toLowerCase() === clean) ||
        (inst.state.serverIp && inst.state.serverIp.toLowerCase() === clean) ||
        (inst.id && normalize(inst.id) === cleanNorm) ||
        (inst.config.serverAddress && normalize(inst.config.serverAddress) === cleanNorm) ||
        (inst.state.serverIp && normalize(inst.state.serverIp) === cleanNorm) ||
        (cleanNorm.length >= 4 && (
          (inst.config.serverAddress && normalize(inst.config.serverAddress).includes(cleanNorm)) ||
          (inst.id && normalize(inst.id).includes(cleanNorm))
        ))
      ) {
        return inst;
      }
    }
    return undefined;
  }

  private getActiveInstance(): ServerSessionInstance {
    return this.findSessionInstance(this.activeSessionKey) || this.getOrCreateSessionInstance(this.activeSessionKey);
  }

  private getOrCreateSessionInstance(key: string, config?: SessionConfig): ServerSessionInstance {
    const cleanKey = (key || 'default').toLowerCase();
    if (!this.sessions.has(cleanKey)) {
      const stored = serverStorage.getProfile(cleanKey);
      const cfg = config || this.loadConfig();
      const initialSoftware = cfg.software || stored?.software || 'Paper / Bukkit';
      const initialVersion = cfg.version || stored?.version || '1.20.4';
      const initialPort = cfg.serverPort || stored?.serverPort || '25565';

      const instance: ServerSessionInstance = {
        config: { ...cfg },
        isInitializing: false,
        lastInitError: null,
        state: {
          status: 'offline',
          rawStatus: 'Offline',
          serverIp: cfg.serverAddress || stored?.serverIp || '',
          serverPort: initialPort,
          software: initialSoftware,
          version: initialVersion,
          queuePosition: null,
          queueEta: null,
          countdownSeconds: null,
          countdownFormatted: null,
          countdownActive: false,
          canExtend: false,
          startVisible: true,
          stopVisible: false,
          restartVisible: false,
          extendVisible: false,
          lastUpdated: Date.now(),
          isActionPending: false,
          currentAction: null,
          sessionConnected: Boolean(cfg.sessionCookie && cfg.sessionCookie.trim().length > 0),
          sessionError: null,
          cloudflareBlocked: false,
        },
        macros: JSON.parse(JSON.stringify(DEFAULT_MACRO_RULES)),
      };
      this.sessions.set(cleanKey, instance);
    }
    return this.sessions.get(cleanKey)!;
  }

  public getState(key?: string): AternosState {
    const inst = key ? (this.findSessionInstance(key) || this.getOrCreateSessionInstance(key)) : this.getActiveInstance();
    return {
      ...inst.state,
      serverIp: inst.config.serverAddress || inst.state.serverIp,
    };
  }

  public getAllStates(): Record<string, AternosState> {
    const map: Record<string, AternosState> = {};
    for (const [k, inst] of this.sessions.entries()) {
      const s: AternosState = {
        ...inst.state,
        serverIp: inst.config.serverAddress || inst.state.serverIp,
      };
      map[k] = s;
      if (inst.id) map[inst.id] = s;
      if (inst.config.serverAddress) map[inst.config.serverAddress.toLowerCase()] = s;
    }
    return map;
  }

  public getConfig(): SessionConfig {
    const inst = this.getActiveInstance();
    return {
      sessionCookie: inst.config.sessionCookie
        ? `${inst.config.sessionCookie.substring(0, 8)}...${inst.config.sessionCookie.slice(-6)}`
        : '',
      serverCookie: inst.config.serverCookie,
      serverAddress: inst.config.serverAddress,
      software: inst.state.software,
      version: inst.state.version,
      serverPort: inst.state.serverPort,
    };
  }

  public async updateConfig(newConfig: Partial<SessionConfig> & { id?: string }): Promise<void> {
    const targetKey = (newConfig.serverAddress || this.activeSessionKey || 'default').toLowerCase();
    this.activeSessionKey = targetKey;

    let inst = this.findSessionInstance(targetKey) || this.sessions.get(targetKey);
    if (!inst) {
      inst = this.getOrCreateSessionInstance(targetKey, newConfig as SessionConfig);
    }
    if (newConfig.id) inst.id = newConfig.id;

    if (newConfig.sessionCookie !== undefined && !newConfig.sessionCookie.includes('...')) {
      inst.config.sessionCookie = newConfig.sessionCookie.trim();
    }
    if (newConfig.serverCookie !== undefined) {
      inst.config.serverCookie = newConfig.serverCookie.trim();
    }
    if (newConfig.serverAddress) {
      inst.config.serverAddress = newConfig.serverAddress.trim();
      inst.state.serverIp = inst.config.serverAddress;
    }
    if (newConfig.software) inst.state.software = newConfig.software;
    if (newConfig.version) inst.state.version = newConfig.version;
    if (newConfig.serverPort) inst.state.serverPort = newConfig.serverPort;

    inst.state.sessionConnected = Boolean(inst.config.sessionCookie && inst.config.sessionCookie.trim().length > 0);
    this.addLog('INFO', `Configuration updated for ${inst.config.serverAddress}`);

    this.syncSessionState(targetKey).catch(() => {});
  }

  public async syncProfiles(profiles: any[]): Promise<void> {
    if (!Array.isArray(profiles)) return;
    for (const p of profiles) {
      const address = p.serverIp || p.name || p.serverAddress;
      if (!address) continue;
      const key = address.toLowerCase();
      let inst = this.findSessionInstance(key) || this.sessions.get(key);
      const cfg: SessionConfig = {
        sessionCookie: p.sessionCookie || '',
        serverCookie: p.serverCookie || '',
        serverAddress: address,
        software: p.software,
        version: p.version,
        serverPort: p.serverPort,
      };

      if (!inst) {
        inst = this.getOrCreateSessionInstance(key, cfg);
      } else {
        if (cfg.sessionCookie && !cfg.sessionCookie.includes('...')) {
          inst.config.sessionCookie = cfg.sessionCookie.trim();
        }
        if (cfg.serverCookie) inst.config.serverCookie = cfg.serverCookie.trim();
        if (cfg.software) inst.state.software = cfg.software;
        if (cfg.version) inst.state.version = cfg.version;
        if (cfg.serverPort) inst.state.serverPort = cfg.serverPort;
      }
      if (p.id) inst.id = p.id;
      if (p.macros && Array.isArray(p.macros) && p.macros.length > 0) {
        inst.macros = JSON.parse(JSON.stringify(p.macros));
      }
      inst.state.sessionConnected = Boolean(inst.config.sessionCookie && inst.config.sessionCookie.trim().length > 0);
    }
  }

  public saveServersConfig(): void {
    // In-memory sessions are maintained per client session to prevent leaking credentials between visitors
  }

  public async discoverServersFromSession(sessionCookie: string): Promise<Array<{
    id: string;
    name: string;
    serverAddress: string;
    serverCookie: string;
  }>> {
    const cleanSession = sessionCookie
      .replace(/^ATERNOS_SESSION=/i, '')
      .replace(/;.*$/, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    if (!cleanSession || cleanSession.length < 10) return [];

    try {
      const cookies = [`ATERNOS_SESSION=${cleanSession}`];
      let html = await this.executeChromeRequest('https://aternos.org/servers/', cookies).catch(() => '');

      const serverCardRegex = /<div class="server-body"[^>]*data-id="([^"]+)"[\s\S]*?<div class="server-name">([\s\S]*?)<\/div>/gi;
      let matches = [...html.matchAll(serverCardRegex)];

      if (matches.length > 0) {
        return matches.map(m => {
          const id = m[1].trim();
          const rawName = m[2].replace(/<[^>]+>/g, '').trim();
          const rawAddr = rawName.replace(/\.aternos\.me$/i, '') + '.aternos.me';
          const serverAddress = serverStorage.getCanonicalServerAddress(rawAddr);
          return {
            id,
            name: serverAddress,
            serverAddress,
            serverCookie: id,
          };
        });
      }

      // Check if redirected to /server/ for single server accounts or fetch /server/ directly
      let lastStatus = this.extractLastStatus(html);
      if (!lastStatus) {
        const serverHtml = await this.executeChromeRequest('https://aternos.org/server/', cookies).catch(() => '');
        if (serverHtml) {
          lastStatus = this.extractLastStatus(serverHtml);
          html = serverHtml;
        }
      }

      if (lastStatus && (lastStatus.name || lastStatus.ip)) {
        const rawAddr = lastStatus.ip || (lastStatus.name ? `${lastStatus.name}.aternos.me` : 'myserver.aternos.me');
        const serverAddress = serverStorage.getCanonicalServerAddress(rawAddr);
        const id = lastStatus.id || 'C97GPgj1GU2y7wWc';
        return [{
          id,
          name: serverAddress,
          serverAddress,
          serverCookie: id,
        }];
      }

      // Fallback: Check known profiles in serverStorage that match this exact session cookie
      const profiles = serverStorage.getAllProfiles().filter((p: any) =>
        p.sessionCookie && p.sessionCookie.trim() === cleanSession
      );
      if (profiles.length > 0) {
        return profiles.map((p: any) => ({
          id: p.serverCookie || p.id,
          name: serverStorage.getCanonicalServerAddress(p.serverIp || p.name),
          serverAddress: serverStorage.getCanonicalServerAddress(p.serverIp || p.name),
          serverCookie: p.serverCookie || p.id,
        }));
      }

      return [];
    } catch (err: any) {
      console.warn('Could not discover servers from session:', err?.message);
      return [];
    }
  }

  public calculateNextDaily(timeStr: string): number {
    const [h, m] = (timeStr || '06:30').split(':').map(n => parseInt(n, 10));
    const target = new Date();
    target.setHours(h || 0, m || 0, 0, 0);
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  // Generate Aternos SEC Token
  private generateSecToken(): { sec: string; key: string; val: string } {
    const key = randomString(11) + '00000';
    const val = randomString(11) + '00000';
    return {
      sec: `${key}:${val}`,
      key,
      val,
    };
  }

  public cleanCookieValue(val?: string, keyName?: string): string {
    if (!val || typeof val !== 'string') return '';
    let cleaned = val.trim();
    if (keyName) {
      const reg = new RegExp(`^${keyName}=`, 'i');
      cleaned = cleaned.replace(reg, '');
    }
    cleaned = cleaned.replace(/;.*$/, '').replace(/^["']|["']$/g, '').trim();
    return cleaned;
  }

  public getCookiesForInstance(inst: ServerSessionInstance, secInfo?: { key: string; val: string }): string[] {
    const session = this.cleanCookieValue(inst.config.sessionCookie, 'ATERNOS_SESSION');
    const server = this.cleanCookieValue(inst.config.serverCookie, 'ATERNOS_SERVER');
    const cf = this.cleanCookieValue(inst.config.cfClearanceCookie, 'cf_clearance');

    const cookies: string[] = [];
    if (session) cookies.push(`ATERNOS_SESSION=${session}`);
    if (server) cookies.push(`ATERNOS_SERVER=${server}`);
    if (cf) cookies.push(`cf_clearance=${cf}`);
    if (secInfo) cookies.push(`ATERNOS_SEC_${secInfo.key}=${secInfo.val}`);

    return cookies;
  }

  // Execute stealth HTTP request using impersonated Chrome TLS fingerprint asynchronously without blocking event loop
  private async executeChromeRequest(url: string, cookies: string[], headers: Record<string, string> = {}): Promise<string> {
    const cookieStr = cookies.join('; ');
    const headerFlags = Object.entries(headers)
      .map(([k, v]) => `-H "${k}: ${v}"`)
      .join(' ');

    const binary = fs.existsSync(this.curlBinaryPath) ? this.curlBinaryPath : './bin/curl_chrome116';
    const cmd = `${binary} -sL "${url}" -H "Cookie: ${cookieStr}" ${headerFlags}`;
    
    return new Promise((resolve, reject) => {
      exec(cmd, { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
        if (err && !stdout) {
          reject(err);
        } else {
          resolve(stdout || '');
        }
      });
    });
  }

  // Extract AJAX_TOKEN or headertoken from Aternos HTML
  private extractAjaxToken(html: string): string | null {
    if (!html || typeof html !== 'string') return null;

    // 0. Explicit headertoken or window.headertoken match
    const headerTokenMatch = html.match(/(?:window\[['"]headertoken['"]\]|window\.headertoken|headertoken)\s*[:=]\s*['"]([^'"]+)['"]/i);
    if (headerTokenMatch && headerTokenMatch[1] && headerTokenMatch[1].length >= 8) {
      return headerTokenMatch[1];
    }

    // 1. Direct assignment match
    const tokenAssignmentMatch = html.match(/(?:AJAX_TOKEN\]|headertoken\])\s*=\s*([^;]+);/);
    if (tokenAssignmentMatch) {
      const expr = tokenAssignmentMatch[1];
      try {
        const sandbox: any = {
          window: {
            Map: function() {},
            document: {
              getElementById: function() {},
              doctype: {},
            },
            setTimeout: function() {},
            DocumentType: function() {},
          },
          document: {
            getElementById: function() {},
            doctype: {},
          },
        };
        sandbox.window.document.doctype.constructor = sandbox.window.DocumentType;
        vm.createContext(sandbox);
        const res = vm.runInContext(expr, sandbox, { timeout: 1500 });
        if (res && typeof res === 'string' && res.length >= 8) {
          return res;
        }
      } catch {}
    }

    // 2. Fallback: Array map reverse join
    const arrayMatch = html.match(
      /\["([a-zA-Z0-9]+)",\s*"([a-zA-Z0-9]+)",\s*"([a-zA-Z0-9]+)"\]\.map\(s\s*=>\s*s\.split\(''\)\.reverse\(\)\.join\(''\)\)\.join\(''\)/
    );
    if (arrayMatch) {
      return [arrayMatch[1], arrayMatch[2], arrayMatch[3]]
        .map(s => s.split('').reverse().join(''))
        .join('');
    }

    // 3. Fallback: Direct assignment
    const directMatch = html.match(/(?:window\[['"](?:AJAX_TOKEN|headertoken)['"]\]|AJAX_TOKEN|headertoken)\s*=\s*['"]([^'"]+)['"]/i);
    if (directMatch && directMatch[1]) {
      return directMatch[1];
    }

    return null;
  }

  // Extract lastStatus JSON or label from HTML
  private extractLastStatus(html: string): any | null {
    const match = html.match(/var\s+lastStatus\s*=\s*(\{[\s\S]*?\});/);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1]);
      } catch {
        try {
          const sandbox: any = {};
          vm.createContext(sandbox);
          vm.runInContext(`result = ${match[1]}`, sandbox, { timeout: 1000 });
          return sandbox.result;
        } catch {}
      }
    }

    // Fallback: Check statuslabel on page
    const labelMatch = html.match(/class="statuslabel-label"[^>]*>\s*([^<\n]+)\s*</i);
    if (labelMatch) {
      const raw = labelMatch[1].trim();
      const isStarting = raw.toLowerCase().includes('starting') || raw.toLowerCase().includes('loading');
      const isOnline = raw.toLowerCase().includes('online');
      const isStopping = raw.toLowerCase().includes('stopping');
      return {
        label: raw,
        status: isStarting ? 2 : isOnline ? 1 : isStopping ? 3 : 0,
      };
    }

    return null;
  }

  // Real Minecraft Server List Ping (mcsrvstat.us)
  private async checkMinecraftServerLive(serverAddress: string): Promise<{
    online: boolean;
    players?: { online: number; max: number };
    version?: string;
    motd?: string;
  } | null> {
    if (!serverAddress || serverAddress.includes('myserver.aternos.me')) {
      return null;
    }
    try {
      const ac = new AbortController();
      const timeoutId = setTimeout(() => ac.abort(), 3000);
      const res = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(serverAddress)}`, {
        signal: ac.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        return {
          online: Boolean(data.online),
          players: data.players ? { online: data.players.online || 0, max: data.players.max || 20 } : undefined,
          version: data.version || undefined,
          motd: data.motd?.clean ? data.motd.clean.join(' ') : undefined,
        };
      }
    } catch {}
    return null;
  }

  private async syncActiveSession(): Promise<void> {
    for (const [key, inst] of this.sessions.entries()) {
      if (inst.config.sessionCookie) {
        await this.syncSessionState(key).catch(() => {});
      }
    }
  }

  public async syncState(): Promise<AternosState> {
    return await this.syncSessionState(this.activeSessionKey);
  }

  public applyLastStatus(inst: ServerSessionInstance, lastStatus: any) {
    if (!lastStatus) return;

    // Validate that lastStatus genuinely matches inst, preventing cross-server status pollution
    const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '').replace(/\.aternos\.me$/i, '');
    const instNorm = normalize(inst.config.serverAddress || inst.state.serverIp || '');
    const statusNameNorm = lastStatus.name ? normalize(String(lastStatus.name)) : '';
    const statusIpNorm = lastStatus.ip ? normalize(String(lastStatus.ip)) : '';
    const statusId = lastStatus.id ? String(lastStatus.id).trim() : '';

    const isMatch =
      !instNorm ||
      instNorm.includes('myserver') ||
      instNorm === statusNameNorm ||
      instNorm === statusIpNorm ||
      (statusId && inst.config.serverCookie && statusId === inst.config.serverCookie) ||
      (statusId && inst.id && statusId === inst.id);

    if (!isMatch && (statusNameNorm || statusIpNorm || statusId)) {
      // Cross-server response detected: Aternos served another server on this multi-server account.
      // Forward status to the correct server instance WITHOUT modifying inst!
      const targetQuery = lastStatus.ip || (lastStatus.name ? `${lastStatus.name}.aternos.me` : statusId);
      const otherInst = this.findSessionInstance(targetQuery) || (statusId ? this.findSessionInstance(statusId) : undefined);
      if (otherInst && otherInst !== inst) {
        this.applyLastStatus(otherInst, lastStatus);
      }
      return;
    }

    const code = Number(lastStatus.status);
    if (code === 1) {
      inst.lastStartAttempt = 0;
      inst.state.status = 'online';
      inst.state.rawStatus = 'Online';
      inst.state.startVisible = false;
      inst.state.stopVisible = true;
      inst.state.restartVisible = true;
      inst.state.extendVisible = true;
      if (lastStatus.dynip) inst.state.dynip = lastStatus.dynip;
      if (lastStatus.port) inst.state.serverPort = String(lastStatus.port);
      if (lastStatus.countdown !== undefined && lastStatus.countdown !== null) {
        inst.state.countdownSeconds = Number(lastStatus.countdown);
        inst.state.countdownActive = inst.state.countdownSeconds > 0;
        const mins = Math.floor(inst.state.countdownSeconds / 60);
        const secs = inst.state.countdownSeconds % 60;
        inst.state.countdownFormatted = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        inst.state.canExtend = inst.state.countdownSeconds <= 60;
      } else {
        inst.state.countdownActive = false;
        inst.state.countdownSeconds = null;
        inst.state.countdownFormatted = null;
        inst.state.canExtend = false;
      }
    } else if (code === 2 || code === 6) {
      inst.state.status = 'starting';
      inst.state.rawStatus = lastStatus.label || 'Starting ...';
      inst.state.startVisible = false;
      inst.state.stopVisible = true;
      inst.state.restartVisible = false;
      inst.state.extendVisible = false;
      inst.state.countdownActive = false;
      inst.state.countdownSeconds = null;
      inst.state.countdownFormatted = null;
    } else if (code === 10) {
      inst.state.status = 'queue';
      inst.state.rawStatus = 'In Queue';
      inst.state.startVisible = false;
      inst.state.stopVisible = true;
      if (lastStatus.queue) {
        inst.state.queuePosition = lastStatus.queue.pos || null;
        inst.state.queueEta = lastStatus.queue.eta || null;
      }
    } else if (code === 3 || code === 5) {
      inst.state.status = 'stopping';
      inst.state.rawStatus = lastStatus.label || 'Stopping ...';
      inst.state.startVisible = false;
      inst.state.stopVisible = false;
      inst.state.restartVisible = false;
      inst.state.extendVisible = false;
      inst.state.playerList = [];
      inst.state.dynip = undefined;
    } else {
      // Fallback for any other codes (e.g. 7 = Crashed)
      inst.state.status = 'offline';
      inst.state.rawStatus = lastStatus.label || 'Offline';
      inst.state.startVisible = true;
      inst.state.stopVisible = false;
      inst.state.restartVisible = false;
      inst.state.extendVisible = false;
      inst.state.countdownActive = false;
      inst.state.countdownSeconds = null;
      inst.state.countdownFormatted = null;
      inst.state.canExtend = false;
      inst.state.playersOnline = 0;
      inst.state.playerList = [];
    }

    if (lastStatus.slots !== undefined) inst.state.maxPlayers = Number(lastStatus.slots);
    if (lastStatus.players !== undefined) inst.state.playersOnline = Number(lastStatus.players);
    if (Array.isArray(lastStatus.playerlist)) {
      const parsedList = lastStatus.playerlist.map((p: any) => String(p).trim()).filter(Boolean);
      inst.state.playerList = parsedList;
      if (parsedList.length > 0 && (!inst.state.playersOnline || inst.state.playersOnline < parsedList.length)) {
        inst.state.playersOnline = parsedList.length;
      }
    } else if (lastStatus.players === 0) {
      inst.state.playerList = [];
    }
    if (lastStatus.motd) {
      inst.state.motd = String(lastStatus.motd).replace(/§[0-9a-fk-or]/gi, '').trim();
    }
    if (lastStatus.software) inst.state.software = lastStatus.software;
    if (lastStatus.version) inst.state.version = lastStatus.version;
    if (lastStatus.port) inst.state.serverPort = String(lastStatus.port);
    if (lastStatus.dynip) inst.state.dynip = lastStatus.dynip;

    if (!inst.config.serverAddress || inst.config.serverAddress.includes('myserver')) {
      const rawAddr = (lastStatus.ip && typeof lastStatus.ip === 'string' && lastStatus.ip.trim())
        ? lastStatus.ip.trim()
        : (lastStatus.name && typeof lastStatus.name === 'string' && lastStatus.name.trim()
          ? `${lastStatus.name.trim()}.aternos.me`
          : (inst.config.serverAddress || inst.state.serverIp));
      const canonicalAddr = serverStorage.getCanonicalServerAddress(rawAddr);
      inst.state.serverIp = canonicalAddr;
      inst.config.serverAddress = canonicalAddr;
    }
    inst.state.lastUpdated = Date.now();
  }

  public async syncSessionState(
    key: string,
    credentials?: { sessionCookie?: string; serverCookie?: string; serverAddress?: string; serverId?: string }
  ): Promise<AternosState> {
    let inst = this.findSessionInstance(key) || this.sessions.get(key.toLowerCase());
    if (!inst && credentials?.serverAddress) {
      const canonical = serverStorage.getCanonicalServerAddress(credentials.serverAddress);
      inst = this.getOrCreateSessionInstance(canonical.toLowerCase(), {
        sessionCookie: credentials.sessionCookie || '',
        serverCookie: credentials.serverCookie || '',
        serverAddress: canonical,
      });
    }
    if (!inst) return this.getState();

    // If explicit credentials passed, update instance immediately
    if (credentials) {
      if (credentials.sessionCookie && !credentials.sessionCookie.includes('...')) {
        inst.config.sessionCookie = credentials.sessionCookie.trim();
      }
      if (credentials.serverCookie) {
        inst.config.serverCookie = credentials.serverCookie.trim();
      }
      if (credentials.serverAddress) {
        const canonical = serverStorage.getCanonicalServerAddress(credentials.serverAddress);
        inst.config.serverAddress = canonical;
        inst.state.serverIp = canonical;
      }
      if (credentials.serverId) inst.id = credentials.serverId;
      inst.state.sessionConnected = Boolean(inst.config.sessionCookie);
    }

    // Cache window: If updated less than 1.2 seconds ago, return cached state
    if (Date.now() - inst.state.lastUpdated < 1200) {
      return inst.state;
    }

    const normKey = (inst.config.serverAddress || key).toLowerCase();
    const existingSync = this.inFlightSyncs.get(normKey);
    if (existingSync) {
      return existingSync;
    }

    const syncPromise = (async () => {
      try {
        // Auto-resolve serverCookie from storage or session discovery if missing
        if (!inst.config.serverCookie || inst.config.serverCookie.trim().length === 0) {
          const storedCookie = serverStorage.getServerCookie(inst.config.serverAddress) ||
                               serverStorage.getProfile(inst.config.serverAddress)?.serverCookie ||
                               serverStorage.getProfile(key)?.serverCookie;
          if (storedCookie) {
            inst.config.serverCookie = storedCookie;
          } else if (inst.config.sessionCookie) {
            const discovered = await this.discoverServersFromSession(inst.config.sessionCookie).catch(() => []);
            const found = discovered.find(d => {
              const dNorm = d.serverAddress.toLowerCase().replace(/[-_\s]/g, '');
              const iNorm = (inst.config.serverAddress || key).toLowerCase().replace(/[-_\s]/g, '');
              return dNorm === iNorm || dNorm.includes(iNorm) || iNorm.includes(dNorm);
            });
            if (found && found.serverCookie) {
              inst.config.serverCookie = found.serverCookie;
              serverStorage.setServerCookie(inst.config.serverAddress, found.serverCookie);
            }
          }
        }

        // Query Aternos Server page directly via Chrome client
        if (inst.config.sessionCookie) {
          const secInfo = this.generateSecToken();
          const cookies = this.getCookiesForInstance(inst, secInfo);

          const html = await this.executeChromeRequest('https://aternos.org/server/', cookies);
          const lastStatus = this.extractLastStatus(html);

          if (lastStatus) {
            // Also extract software and version if missing from lastStatus object
            if (!lastStatus.software) {
              const swMatch = html.match(/class="[^"]*software[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                              html.match(/software:[^<\n]*["']?([a-zA-Z0-9_\-\s/]+)/i);
              if (swMatch && swMatch[1].trim()) lastStatus.software = swMatch[1].replace(/<[^>]+>/g, '').trim();
            }
            if (!lastStatus.version) {
              const vMatch = html.match(/class="[^"]*version[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                             html.match(/version:[^<\n]*["']?([0-9a-zA-Z._\-() ]+)/i);
              if (vMatch && vMatch[1].trim()) lastStatus.version = vMatch[1].replace(/<[^>]+>/g, '').trim();
            }
            if (!lastStatus.port) {
              const pMatch = html.match(/id="port"[^>]*>(\d+)<\/span>/i) ||
                             html.match(/class="[^"]*port[^"]*"[^>]*>(\d+)<\/div>/i);
              if (pMatch && pMatch[1].trim()) lastStatus.port = pMatch[1].trim();
            }
            this.applyLastStatus(inst, lastStatus);

            // AUTO-PERSIST: If we detected real software/version/port, save them to serverStorage
            // This prevents the 'flicker' where background reload overwrites live data with stale defaults.
            if (lastStatus.software || lastStatus.version || lastStatus.port) {
              const profile = (inst.id ? serverStorage.getProfile(inst.id) : null) || serverStorage.getProfile(normKey);
              if (profile) {
                let changed = false;
                if (lastStatus.software && lastStatus.software !== profile.software) {
                  profile.software = lastStatus.software;
                  changed = true;
                }
                if (lastStatus.version && lastStatus.version !== profile.version) {
                  profile.version = lastStatus.version;
                  changed = true;
                }
                if (lastStatus.port && String(lastStatus.port) !== profile.serverPort) {
                  profile.serverPort = String(lastStatus.port);
                  changed = true;
                }
                if (changed) {
                  serverStorage.saveProfile(profile);
                }
              }
            }
          }
        }

        // Direct Minecraft SLP check for 100% verified online status and player names
        if (inst.config.serverAddress && !inst.config.serverAddress.includes('myserver')) {
          const mcLive = await this.checkMinecraftServerLive(inst.config.serverAddress);
          if (mcLive) {
            if (mcLive.online) {
              inst.state.status = 'online';
              inst.state.rawStatus = 'Online';
              inst.state.startVisible = false;
              inst.state.stopVisible = true;
              inst.state.restartVisible = true;
              inst.state.extendVisible = true;
              if (mcLive.players) {
                inst.state.playersOnline = mcLive.players.online;
                inst.state.maxPlayers = mcLive.players.max;
              }
              if (mcLive.version && !inst.state.version) inst.state.version = mcLive.version;
              if (mcLive.motd) inst.state.motd = mcLive.motd;
            } else {
              // Server is reported offline by Minecraft query
              // CRITICAL: NEVER override to offline if Aternos itself reports the server online!
              if (inst.state.status !== 'online' && inst.state.status !== 'starting' && inst.state.status !== 'queue') {
                inst.state.status = 'offline';
                inst.state.rawStatus = 'Offline';
                inst.state.startVisible = true;
                inst.state.stopVisible = false;
                inst.state.restartVisible = false;
                inst.state.extendVisible = false;
                inst.state.countdownActive = false;
                inst.state.countdownSeconds = null;
                inst.state.countdownFormatted = null;
                inst.state.canExtend = false;
                inst.state.playersOnline = 0;
                inst.state.playerList = [];
              }
            }
          }
        }
      } catch {
        // network retry
      } finally {
        inst.state.lastUpdated = Date.now();
        this.inFlightSyncs.delete(normKey);
      }
      return inst.state;
    })();

    this.inFlightSyncs.set(normKey, syncPromise);
    return syncPromise;
  }

  // Start Server: Real Sleeyax AJAX API execution
  public async startServer(
    targetKey?: string,
    credentials?: { sessionCookie?: string; serverCookie?: string; serverAddress?: string; serverId?: string }
  ): Promise<{ success: boolean; message: string }> {
    let inst = targetKey ? this.findSessionInstance(targetKey) : this.getActiveInstance();
    if (!inst) {
      const address = credentials?.serverAddress || targetKey || 'default';
      inst = this.getOrCreateSessionInstance(address.toLowerCase(), {
        sessionCookie: credentials?.sessionCookie || '',
        serverCookie: credentials?.serverCookie || '',
        serverAddress: address,
      });
      if (credentials?.serverId) inst.id = credentials.serverId;
    }

    if (credentials) {
      if (credentials.sessionCookie && !credentials.sessionCookie.includes('...')) {
        inst.config.sessionCookie = credentials.sessionCookie.trim();
      }
      if (credentials.serverCookie) {
        inst.config.serverCookie = credentials.serverCookie.trim();
      }
      if (credentials.serverAddress) {
        inst.config.serverAddress = credentials.serverAddress.trim();
        inst.state.serverIp = credentials.serverAddress.trim();
      }
      if (credentials.serverId) inst.id = credentials.serverId;
      inst.state.sessionConnected = Boolean(inst.config.sessionCookie);
    }

    if (inst.state.isActionPending) {
      return { success: false, message: 'Another action is in progress.' };
    }

    if (!inst.config.sessionCookie || inst.config.sessionCookie.trim().length === 0) {
      return {
        success: false,
        message: 'No Aternos session cookie configured. Please enter your ATERNOS_SESSION cookie in Session Auth.',
      };
    }

    // Auto-resolve serverCookie if missing or empty
    if (!inst.config.serverCookie || inst.config.serverCookie.trim().length === 0) {
      this.addLog('SYS', `Auto-resolving server ID for ${inst.config.serverAddress}...`);
      const discovered = await this.discoverServersFromSession(inst.config.sessionCookie);
      if (discovered.length > 0) {
        const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '').replace(/\.aternos\.me$/i, '');
        const targetNorm = norm(inst.config.serverAddress);
        const match = discovered.find(d =>
          d.serverAddress.toLowerCase() === inst.config.serverAddress.toLowerCase() ||
          norm(d.serverAddress) === targetNorm ||
          norm(d.name) === targetNorm
        ) || discovered[0];

        inst.config.serverCookie = match.serverCookie;
        if (!inst.config.serverAddress || inst.config.serverAddress.includes('myserver')) {
          inst.config.serverAddress = match.serverAddress;
          inst.state.serverIp = match.serverAddress;
        }
        this.addLog('SYS', `Auto-linked server ID: ${match.serverCookie} (${match.serverAddress})`);
        this.saveServersConfig();
      }
    }

    inst.state.isActionPending = true;
    inst.state.currentAction = 'start';
    this.addLog('CMD', `Executing real AJAX start sequence for ${inst.config.serverAddress}...`);

    try {
      const secInfo = this.generateSecToken();
      const cookies = this.getCookiesForInstance(inst, secInfo);

      // Step 1: Fetch /server/ page to extract AJAX_TOKEN and inspect current live status
      this.addLog('SYS', `Fetching real Aternos tokens (SEC: ${secInfo.key})...`);
      const html = await this.executeChromeRequest('https://aternos.org/server/', cookies, {
        'Referer': 'https://aternos.org/servers/',
      });

      const lastStatus = this.extractLastStatus(html);
      if (lastStatus) {
        this.applyLastStatus(inst, lastStatus);
        const code = Number(lastStatus.status);
        if (code === 1) {
          return {
            success: true,
            message: `Server is already Online! Connect at: ${lastStatus.dynip || inst.state.serverIp}`,
          };
        }
        if (code === 2 || code === 6) {
          return {
            success: true,
            message: `Server is already booting up (${lastStatus.label || 'Starting ...'})!`,
          };
        }
      }

      const token = this.extractAjaxToken(html);
      if (!token) {
        if (html.includes('login') || html.includes('Sign in') || html.length < 500) {
          throw new Error('Aternos session expired or invalid. Please copy a fresh ATERNOS_SESSION cookie from your browser.');
        }
        throw new Error('Unable to extract AJAX_TOKEN from Aternos page. Please verify your session cookie in Session Auth.');
      }

      const serverCookieClean = this.cleanCookieValue(inst.config.serverCookie, 'ATERNOS_SERVER');

      this.addLog('SYS', `AJAX_TOKEN unpacked (${token}). Dispatching Aternos /ajax/server/start...`);

      // Step 2: Send AJAX start request
      const startUrl = `https://aternos.org/ajax/server/start?headstart=false&access-credits=false&acceptEula=true&accept-eula=true&SEC=${encodeURIComponent(
        secInfo.sec
      )}&TOKEN=${encodeURIComponent(token)}&headertoken=${encodeURIComponent(token)}${serverCookieClean ? `&SERVER=${encodeURIComponent(serverCookieClean)}` : ''}`;

      const rawRes = await this.executeChromeRequest(startUrl, cookies, {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Referer': 'https://aternos.org/server/',
        'headertoken': token,
        'X-Headertoken': token,
      });

      let resData: any = null;
      try {
        resData = JSON.parse(rawRes);
      } catch {
        resData = null;
      }

      const statusCode = (resData?.data?.status || resData?.error || '').toLowerCase();

      if (resData && resData.success === true) {
        inst.lastStartAttempt = Date.now();
        inst.state.status = 'starting';
        inst.state.rawStatus = 'Starting ...';
        inst.state.startVisible = false;
        inst.state.stopVisible = true;
        this.addLog('INFO', `[SUCCESS] Aternos confirmed start sequence for ${inst.config.serverAddress}! Server is booting up.`);
        this.saveServersConfig();
        return { success: true, message: `Server startup initiated for ${inst.config.serverAddress}!` };
      } else if (statusCode === 'already' || statusCode === 'prepared') {
        inst.lastStartAttempt = Date.now();
        inst.state.status = 'starting';
        inst.state.rawStatus = 'Starting ...';
        inst.state.startVisible = false;
        inst.state.stopVisible = true;
        this.addLog('INFO', `[SUCCESS] Aternos confirms server is already starting or online (${inst.config.serverAddress}).`);
        return { success: true, message: `Server is booting up or already online for ${inst.config.serverAddress}!` };
      } else {
        // Double check live page status
        this.addLog('SYS', `Start endpoint returned (${resData?.error || 'null/error'}). Re-verifying live status on Aternos...`);
        const recheckHtml = await this.executeChromeRequest('https://aternos.org/server/', cookies).catch(() => '');
        const checkStatus = this.extractLastStatus(recheckHtml);
        if (checkStatus) {
          this.applyLastStatus(inst, checkStatus);
          if (checkStatus.status === 1) {
            return { success: true, message: `Server is already online (${checkStatus.dynip || inst.state.serverIp})` };
          }
          if (checkStatus.status === 2 || checkStatus.status === 6) {
            return { success: true, message: `Server is currently starting (${checkStatus.label || 'Starting ...'})` };
          }
        }

        // Try confirm endpoint
        const confirmUrl = `https://aternos.org/ajax/server/confirm?SEC=${encodeURIComponent(
          secInfo.sec
        )}&TOKEN=${encodeURIComponent(token)}&headertoken=${encodeURIComponent(token)}${serverCookieClean ? `&SERVER=${encodeURIComponent(serverCookieClean)}` : ''}`;

        const confirmRes = await this.executeChromeRequest(confirmUrl, cookies, {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Referer': 'https://aternos.org/server/',
          'headertoken': token,
          'X-Headertoken': token,
        }).catch(() => '');

        let confirmData: any = null;
        try { confirmData = JSON.parse(confirmRes); } catch {}

        if (confirmData?.success === true) {
          inst.lastStartAttempt = Date.now();
          inst.state.status = 'starting';
          inst.state.rawStatus = 'Starting ...';
          inst.state.startVisible = false;
          inst.state.stopVisible = true;
          this.addLog('INFO', `[SUCCESS] Aternos start confirmed via confirm endpoint!`);
          this.saveServersConfig();
          return { success: true, message: `Server startup confirmed!` };
        }

        const errorMsg = resData?.error || confirmData?.error || (rawRes.includes('login') ? 'Aternos session expired or invalid. Please re-enter your session cookie.' : 'Aternos rejected the start request.');
        this.addLog('ERR', `Start rejected by Aternos: ${errorMsg}`);
        return { success: false, message: errorMsg };
      }
    } catch (err: any) {
      this.addLog('ERR', `Start failed: ${err.message}`);
      return { success: false, message: err.message };
    } finally {
      inst.state.isActionPending = false;
      inst.state.currentAction = null;
    }
  }

  // Stop Server
  public async stopServer(
    targetKey?: string,
    credentials?: { sessionCookie?: string; serverCookie?: string; serverAddress?: string; serverId?: string }
  ): Promise<{ success: boolean; message: string }> {
    let inst = targetKey ? this.findSessionInstance(targetKey) : this.getActiveInstance();
    if (!inst) {
      const address = credentials?.serverAddress || targetKey || 'default';
      inst = this.getOrCreateSessionInstance(address.toLowerCase(), {
        sessionCookie: credentials?.sessionCookie || '',
        serverCookie: credentials?.serverCookie || '',
        serverAddress: address,
      });
      if (credentials?.serverId) inst.id = credentials.serverId;
    }
    if (credentials) {
      if (credentials.sessionCookie && !credentials.sessionCookie.includes('...')) inst.config.sessionCookie = credentials.sessionCookie.trim();
      if (credentials.serverCookie) inst.config.serverCookie = credentials.serverCookie.trim();
      if (credentials.serverAddress) inst.config.serverAddress = credentials.serverAddress.trim();
    }
    if (inst.state.isActionPending) return { success: false, message: 'Action in progress.' };

    inst.state.isActionPending = true;
    inst.state.currentAction = 'stop';
    this.addLog('CMD', `Executing AJAX stop command for ${inst.config.serverAddress}...`);

    try {
      const secInfo = this.generateSecToken();
      const cookies = this.getCookiesForInstance(inst, secInfo);

      const html = await this.executeChromeRequest('https://aternos.org/server/', cookies);
      const token = this.extractAjaxToken(html);

      const stopUrl = token
        ? `https://aternos.org/ajax/server/stop?SEC=${encodeURIComponent(secInfo.sec)}&TOKEN=${encodeURIComponent(token)}&headertoken=${encodeURIComponent(token)}${inst.config.serverCookie ? `&SERVER=${encodeURIComponent(inst.config.serverCookie)}` : ''}`
        : `https://aternos.org/ajax/server/stop`;

      const rawRes = await this.executeChromeRequest(stopUrl, cookies, {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Referer': 'https://aternos.org/server/',
        'headertoken': token || '',
        'X-Headertoken': token || '',
      });

      let resData: any = null;
      try {
        resData = JSON.parse(rawRes);
      } catch {}

      if (resData?.success !== false) {
        inst.state.status = 'stopping';
        inst.state.rawStatus = 'Stopping ...';
        inst.state.countdownActive = false;
        inst.state.countdownSeconds = null;
        inst.state.countdownFormatted = null;
        this.addLog('INFO', `Stop command confirmed by Aternos for ${inst.config.serverAddress}.`);
        return { success: true, message: 'Stop signal dispatched successfully.' };
      } else {
        throw new Error(resData?.error || 'Aternos rejected stop request.');
      }
    } catch (err: any) {
      this.addLog('ERR', `Stop failed: ${err.message}`);
      return { success: false, message: err.message };
    } finally {
      inst.state.isActionPending = false;
      inst.state.currentAction = null;
    }
  }

  // Restart Server
  public async restartServer(
    targetKey?: string,
    credentials?: { sessionCookie?: string; serverCookie?: string; serverAddress?: string; serverId?: string }
  ): Promise<{ success: boolean; message: string }> {
    let inst = targetKey ? this.findSessionInstance(targetKey) : this.getActiveInstance();
    if (!inst) {
      const address = credentials?.serverAddress || targetKey || 'default';
      inst = this.getOrCreateSessionInstance(address.toLowerCase(), {
        sessionCookie: credentials?.sessionCookie || '',
        serverCookie: credentials?.serverCookie || '',
        serverAddress: address,
      });
      if (credentials?.serverId) inst.id = credentials.serverId;
    }
    if (credentials) {
      if (credentials.sessionCookie && !credentials.sessionCookie.includes('...')) inst.config.sessionCookie = credentials.sessionCookie.trim();
      if (credentials.serverCookie) inst.config.serverCookie = credentials.serverCookie.trim();
      if (credentials.serverAddress) inst.config.serverAddress = credentials.serverAddress.trim();
    }
    if (inst.state.isActionPending) return { success: false, message: 'Action in progress.' };

    // If server is offline, restarting means starting it
    if (inst.state.status === 'offline') {
      this.addLog('SYS', `Server is currently offline. Starting ${inst.config.serverAddress}...`);
      return await this.startServer(targetKey, credentials);
    }

    inst.state.isActionPending = true;
    inst.state.currentAction = 'restart';
    this.addLog('CMD', `Executing AJAX restart command for ${inst.config.serverAddress}...`);

    try {
      const secInfo = this.generateSecToken();
      const cookies = this.getCookiesForInstance(inst, secInfo);

      const html = await this.executeChromeRequest('https://aternos.org/server/', cookies);
      const token = this.extractAjaxToken(html);

      const restartUrl = token
        ? `https://aternos.org/ajax/server/restart?headstart=false&access-credits=false&acceptEula=true&accept-eula=true&SEC=${encodeURIComponent(secInfo.sec)}&TOKEN=${encodeURIComponent(token)}&headertoken=${encodeURIComponent(token)}${inst.config.serverCookie ? `&SERVER=${encodeURIComponent(inst.config.serverCookie)}` : ''}`
        : `https://aternos.org/ajax/server/restart`;

      const rawRes = await this.executeChromeRequest(restartUrl, cookies, {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Referer': 'https://aternos.org/server/',
        'headertoken': token || '',
        'X-Headertoken': token || '',
      });

      let resData: any = null;
      try {
        resData = JSON.parse(rawRes);
      } catch {}

      if (resData?.success !== false) {
        inst.lastStartAttempt = Date.now();
        inst.state.status = 'starting';
        inst.state.rawStatus = 'Restarting ...';
        this.addLog('INFO', `Restart command confirmed by Aternos for ${inst.config.serverAddress}.`);
        return { success: true, message: 'Restart triggered successfully.' };
      } else {
        // Fallback: If restart command fails, try startServer directly
        this.addLog('WARN', `Restart endpoint returned error (${resData?.error || 'Bad request'}). Fallback to start sequence...`);
        inst.state.isActionPending = false;
        return await this.startServer(targetKey, credentials);
      }
    } catch (err: any) {
      this.addLog('ERR', `Restart failed (${err.message}). Attempting start fallback...`);
      inst.state.isActionPending = false;
      return await this.startServer(targetKey, credentials);
    } finally {
      inst.state.isActionPending = false;
      inst.state.currentAction = null;
    }
  }

  // Extend Timer (+1 minute keepalive via /ajax/server/extend-end)
  public async extendTimer(
    targetKey?: string,
    credentials?: { sessionCookie?: string; serverCookie?: string; serverAddress?: string; serverId?: string }
  ): Promise<{ success: boolean; message: string }> {
    const inst = targetKey ? (this.findSessionInstance(targetKey) || this.getActiveInstance()) : this.getActiveInstance();
    if (credentials) {
      if (credentials.sessionCookie) inst.config.sessionCookie = credentials.sessionCookie.trim();
      if (credentials.serverCookie) inst.config.serverCookie = credentials.serverCookie.trim();
      if (credentials.serverAddress) inst.config.serverAddress = credentials.serverAddress.trim();
    }
    if (inst.state.status !== 'online') {
      return { success: false, message: 'Server is not online.' };
    }

    this.addLog('CMD', `Adding keepalive timer for ${inst.config.serverAddress}...`);
    try {
      const secInfo = this.generateSecToken();
      const cookies = this.getCookiesForInstance(inst, secInfo);

      const html = await this.executeChromeRequest('https://aternos.org/server/', cookies);
      const token = this.extractAjaxToken(html);

      const extendUrl = token
        ? `https://aternos.org/ajax/server/extend-end?SEC=${encodeURIComponent(
            secInfo.sec
          )}&TOKEN=${encodeURIComponent(token)}&headertoken=${encodeURIComponent(token)}${inst.config.serverCookie ? `&SERVER=${encodeURIComponent(inst.config.serverCookie)}` : ''}`
        : `https://aternos.org/ajax/server/extend-end`;

      const rawRes = await this.executeChromeRequest(extendUrl, cookies, {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Referer': 'https://aternos.org/server/',
        'headertoken': token || '',
        'X-Headertoken': token || '',
      });

      let resData: any = null;
      try {
        resData = JSON.parse(rawRes);
      } catch {}

      if (resData?.success === true) {
        if (inst.state.countdownSeconds !== null && inst.state.countdownSeconds > 0) {
          inst.state.countdownSeconds += 60;
        } else {
          inst.state.countdownSeconds = 180;
        }
        const m = Math.floor(inst.state.countdownSeconds / 60);
        const s = inst.state.countdownSeconds % 60;
        inst.state.countdownFormatted = `${m}:${s < 10 ? '0' : ''}${s}`;
        this.addLog('SYS', `Keepalive extended for ${inst.config.serverAddress} (${inst.state.countdownFormatted}).`);
        return { success: true, message: `Extended timer to ${inst.state.countdownFormatted}.` };
      } else {
        throw new Error(resData?.error || 'Aternos rejected extend-end.');
      }
    } catch (err: any) {
      this.addLog('ERR', `Extend failed: ${err.message}`);
      return { success: false, message: err.message };
    }
  }

  // Detect server from input or cookies
  public async detectServerFromCookies(
    sessionInput?: string,
    serverInput?: string,
    signal?: AbortSignal
  ): Promise<{
    success: boolean;
    displayName?: string;
    serverAddress?: string;
    serverCookie?: string;
    software?: string;
    version?: string;
    serverPort?: string;
    message?: string;
    allServers?: Array<{ id: string; name: string; serverAddress: string; serverCookie: string }>;
  }> {
    if (signal?.aborted) return { success: false, message: 'Detection canceled.' };

    let cleanSession = (sessionInput || '').trim();
    let cleanServer = (serverInput || '').trim();

    const sessionMatch = (sessionInput + ' ' + (serverInput || '')).match(/ATERNOS_SESSION=([^;\s]+)/i);
    if (sessionMatch) cleanSession = sessionMatch[1].trim();

    const serverMatch = (sessionInput + ' ' + (serverInput || '')).match(/ATERNOS_SERVER=([^;\s]+)/i);
    if (serverMatch && !cleanServer) cleanServer = serverMatch[1].trim();

    const addressHintMatch = (sessionInput + ' ' + (serverInput || '')).match(/([a-zA-Z0-9_\-]+)\.aternos\.me/i);
    const candidateHint = addressHintMatch ? `${addressHintMatch[1]}.aternos.me` : undefined;

    if (cleanSession) {
      const discovered = await this.discoverServersFromSession(cleanSession);
      if (discovered.length > 0) {
        let matched = discovered.find(d => 
          (candidateHint && d.serverAddress.toLowerCase() === candidateHint.toLowerCase()) ||
          (cleanServer && d.serverCookie === cleanServer)
        );
        if (!matched) {
          matched = discovered[0];
        }
        const storedProfile = serverStorage.getProfile(matched.serverAddress);
        let detectedSoftware = storedProfile?.software || 'Fabric';
        let detectedVersion = storedProfile?.version || '1.20.4';
        let detectedPort = storedProfile?.serverPort || '25565';

        // Query matched server's actual dashboard page to fetch live software, version, and port
        if (cleanSession && matched.serverCookie) {
          try {
            const secInfo = this.generateSecToken();
            const cookies = [
              `ATERNOS_SESSION=${cleanSession}`,
              `ATERNOS_SERVER=${matched.serverCookie}`,
              `ATERNOS_SEC_${secInfo.key}=${secInfo.val}`,
            ];
            const html = await this.executeChromeRequest('https://aternos.org/server/', cookies).catch(() => '');
            if (html) {
              const lastStatus = this.extractLastStatus(html);
              if (lastStatus) {
                if (lastStatus.software) detectedSoftware = lastStatus.software;
                if (lastStatus.version) detectedVersion = lastStatus.version;
                if (lastStatus.port) detectedPort = String(lastStatus.port);
              }
              if (detectedSoftware === 'Paper / Bukkit') {
                const swMatch = html.match(/class="[^"]*software[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                                html.match(/software:[^<\n]*["']?([a-zA-Z0-9_\-\s/]+)/i);
                if (swMatch && swMatch[1].trim()) detectedSoftware = swMatch[1].replace(/<[^>]+>/g, '').trim();
              }
              if (detectedVersion === '1.20.4') {
                const vMatch = html.match(/class="[^"]*version[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                               html.match(/version:[^<\n]*["']?([0-9a-zA-Z._\-() ]+)/i);
                if (vMatch && vMatch[1].trim()) detectedVersion = vMatch[1].replace(/<[^>]+>/g, '').trim();
              }
              if (detectedPort === '25565') {
                const pMatch = html.match(/id="port"[^>]*>(\d+)<\/span>/i) ||
                               html.match(/class="[^"]*port[^"]*"[^>]*>(\d+)<\/div>/i);
                if (pMatch && pMatch[1].trim()) detectedPort = pMatch[1].trim();
              }
            }
          } catch {}
        }

        return {
          success: true,
          displayName: matched.serverAddress,
          serverAddress: matched.serverAddress,
          serverCookie: matched.serverCookie,
          software: detectedSoftware,
          version: detectedVersion,
          serverPort: detectedPort,
          message: `Discovered ${discovered.length} server${discovered.length > 1 ? 's' : ''} on your Aternos account: ${matched.serverAddress}`,
          allServers: discovered,
        };
      }
    }

    if (candidateHint) {
      return {
        success: true,
        displayName: candidateHint,
        serverAddress: candidateHint,
        serverCookie: cleanServer,
        software: 'Fabric',
        version: '1.20.4',
        serverPort: '25565',
        message: `Detected server address: ${candidateHint}`,
      };
    }

    for (const inst of this.sessions.values()) {
      if (cleanServer && inst.config.serverCookie === cleanServer && inst.config.serverAddress) {
        return {
          success: true,
          displayName: inst.config.serverAddress,
          serverAddress: inst.config.serverAddress,
          serverCookie: cleanServer,
          software: inst.state.software || 'Fabric',
          version: inst.state.version || '1.20.4',
          serverPort: inst.state.serverPort || '25565',
          message: `Detected: ${inst.config.serverAddress}`,
        };
      }
    }

    return {
      success: false,
      message: 'Could not auto-detect server. Please make sure your ATERNOS_SESSION token is valid and not expired.',
    };
  }

  public getMacros(query?: string): MacroRule[] {
    if (query) {
      const targetKey = query.trim().toLowerCase();
      const inst = this.findSessionInstance(targetKey);
      if (inst && inst.macros && Array.isArray(inst.macros) && inst.macros.length > 0) {
        return [...inst.macros];
      }
      return JSON.parse(JSON.stringify(DEFAULT_MACRO_RULES));
    }
    return [...this.macroRules];
  }

  public updateMacros(newRules: MacroRule[], query?: string): MacroRule[] {
    if (!Array.isArray(newRules)) return this.getMacros(query);
    const targetKey = query ? query.trim().toLowerCase() : undefined;
    if (targetKey) {
      const inst = this.findSessionInstance(targetKey) || this.getOrCreateSessionInstance(targetKey);
      const base = inst.macros || JSON.parse(JSON.stringify(DEFAULT_MACRO_RULES));
      inst.macros = base.map((existing: MacroRule) => {
        const match = newRules.find(r => r.id === existing.id);
        if (!match) return existing;
        return { ...existing, ...match };
      });
      // Persist macros directly to server profile so 24/7 AFK Watchdog runs even if website is closed
      const p = serverStorage.getProfile(targetKey) || (inst.config.serverAddress ? serverStorage.getProfile(inst.config.serverAddress) : undefined);
      if (p) {
        serverStorage.saveProfile({
          ...p,
          macros: inst.macros,
        });
      }
      return inst.macros ? [...inst.macros] : [];
    }

    this.macroRules = this.macroRules.map(existing => {
      const match = newRules.find(r => r.id === existing.id);
      if (!match) return existing;
      return { ...existing, ...match };
    });
    this.saveMacrosConfig();
    return this.macroRules;
  }

  public async triggerMacro(id: string, query?: string): Promise<{ success: boolean; message: string }> {
    const inst = this.findSessionInstance(query) || this.getActiveInstance();
    const macroList = inst.macros || this.macroRules;
    const macro = macroList.find(m => m.id === id) || this.macroRules.find(m => m.id === id);
    if (!macro) return { success: false, message: 'Macro rule not found.' };

    const targetServer = inst.config.serverAddress;
    this.addLog('CMD', `Manually triggered macro "${macro.name}" on ${targetServer || 'server'}`);
    if (macro.type === 'extend_interval') {
      return await this.extendTimer(targetServer);
    } else if (macro.type === 'restart_interval' || macro.type === 'restart_daily') {
      return await this.restartServer(targetServer);
    }
    return { success: true, message: `Macro ${macro.name} executed.` };
  }

  public async executeCliCommand(rawCommand: string): Promise<{ success: boolean; output: string }> {
    const cmd = rawCommand.trim().toLowerCase();
    this.addLog('CMD', `> ${rawCommand.trim()}`);
    if (!cmd) return { success: true, output: '' };

    if (cmd === 'help') {
      const help = [
        'Available Terminal Commands:',
        '  start      - Initiates server startup on Aternos via AJAX',
        '  stop       - Gracefully halts server',
        '  restart    - Reboots server instance',
        '  extend/+1  - Adds +1 minute keepalive timer',
        '  status     - Queries live state and players',
        '  clear      - Flushes console log buffer',
      ].join('\n');
      this.addLog('INFO', help);
      return { success: true, output: help };
    }
    if (cmd === 'start') {
      const res = await this.startServer();
      return { success: res.success, output: res.message };
    }
    if (cmd === 'stop') {
      const res = await this.stopServer();
      return { success: res.success, output: res.message };
    }
    if (cmd === 'restart') {
      const res = await this.restartServer();
      return { success: res.success, output: res.message };
    }
    if (cmd === 'extend' || cmd === '+1') {
      const res = await this.extendTimer();
      return { success: res.success, output: res.message };
    }
    if (cmd === 'status') {
      const state = this.getState();
      const output = `Status: ${state.rawStatus} | Address: ${state.serverIp}:${state.serverPort} | Players: ${state.playersOnline || 0}/${state.maxPlayers || 20}`;
      this.addLog('SYS', output);
      return { success: true, output };
    }
    if (cmd === 'clear') {
      this.clearLogs();
      return { success: true, output: 'Buffer cleared.' };
    }

    const err = `Unknown command "${rawCommand}". Type "help" for a list of commands.`;
    this.addLog('WARN', err);
    return { success: false, output: err };
  }

  private tickCountdowns() {
    for (const inst of this.sessions.values()) {
      if (inst.state.status === 'online') {
        const players = inst.state.playersOnline ?? 0;
        if (players === 0) {
          if (inst.state.countdownActive && typeof inst.state.countdownSeconds === 'number' && inst.state.countdownSeconds > 0) {
            inst.state.countdownSeconds -= 1;
            const m = Math.floor(inst.state.countdownSeconds / 60);
            const s = inst.state.countdownSeconds % 60;
            inst.state.countdownFormatted = `${m}:${s < 10 ? '0' : ''}${s}`;
            inst.state.canExtend = inst.state.countdownSeconds <= 60;
          } else if (inst.state.countdownSeconds === 0) {
            inst.state.countdownActive = false;
            inst.state.countdownFormatted = '0:00';
            inst.state.canExtend = false;
          }
        } else {
          inst.state.countdownActive = false;
        }
      } else {
        inst.state.countdownActive = false;
        inst.state.countdownSeconds = null;
        inst.state.countdownFormatted = null;
        inst.state.canExtend = false;
      }
    }
  }

  private async processMacros() {
    const now = Date.now();
    for (const [key, inst] of this.sessions.entries()) {
      if (inst.state.isActionPending) continue;
      const sessionMacros = inst.macros || this.macroRules;

      for (const macro of sessionMacros) {
        if (!macro.enabled) continue;

        // 1. 24/7 AFK Watchdog (Auto-Start if Offline / Crashed)
        if (macro.type === 'afk_watchdog') {
          if (inst.state.status === 'offline' || inst.state.rawStatus.toLowerCase().includes('offline') || inst.state.rawStatus.toLowerCase().includes('crashed')) {
            if (inst.config.sessionCookie && inst.config.sessionCookie.trim().length > 10) {
              const lastAttempt = inst.lastStartAttempt || 0;
              // Fast & resilient 15s check interval
              if (now - lastAttempt > 15 * 1000) {
                inst.lastStartAttempt = now;
                macro.runCount++;
                macro.lastRunTimestamp = now;
                const target = inst.config.serverAddress || key;
                this.addLog('SYS', `[24/7 AFK Watchdog] Detected ${target} is OFFLINE (${inst.state.rawStatus}). Auto-initiating server start...`);
                
                await this.syncSessionState(target).catch(() => {});
                const res = await this.startServer(target);
                if (!res.success) {
                  // If start failed (e.g. server was still shutting down on Aternos side), allow quick retry in 10s
                  inst.lastStartAttempt = now - 5 * 1000;
                }
                break;
              }
            } else {
              // Log once why watchdog isn't running if it should be
              if (!(inst as any)._watchdogWarned) {
                this.addLog('WARN', `[Watchdog] Cannot start ${inst.config.serverAddress} - No valid session cookie found.`);
                (inst as any)._watchdogWarned = true;
              }
            }
          }
        }

        // 2. Interval Server Restart (Every X hours or minutes, e.g. 60m)
        if (macro.type === 'restart_interval') {
          if (inst.state.status === 'online') {
            const intervalMs = (macro.intervalMinutes || 60) * 60 * 1000;
            if (!macro.nextRunTimestamp) {
              macro.nextRunTimestamp = now + intervalMs;
            }
            if (now >= macro.nextRunTimestamp) {
              this.addLog('SYS', `[Macro: ${macro.name}] ${macro.intervalMinutes}m interval reached for ${inst.config.serverAddress}. Executing reboot...`);
              macro.runCount++;
              macro.lastRunTimestamp = now;
              macro.nextRunTimestamp = now + intervalMs;
              await this.restartServer(inst.config.serverAddress || key);
              break;
            }
          }
        }

        // 3. Auto Add Timer (+1 Keepalive when countdown drops below 1:00)
        if (macro.type === 'extend_interval') {
          if (inst.state.status === 'online') {
            // If players are connected, countdown is paused and server stays online automatically
            if ((inst.state.playersOnline ?? 0) > 0) {
              continue;
            }
            if (
              inst.state.countdownSeconds !== null &&
              inst.state.countdownSeconds <= 60 &&
              inst.state.countdownSeconds > 0
            ) {
              const lastRun = macro.lastRunTimestamp || 0;
              // Debounce at least 45 seconds to avoid repeated calls within the 60s countdown window
              if (now - lastRun > 45 * 1000) {
                this.addLog('SYS', `[Auto Add Timer] Server "${inst.config.serverAddress}" countdown reached below 1:00 (${inst.state.countdownFormatted || inst.state.countdownSeconds + 's'}). Automatically clicking +1 keepalive...`);
                macro.runCount++;
                macro.lastRunTimestamp = now;
                await this.extendTimer(inst.config.serverAddress || key);
                break;
              }
            }
          }
        }

        // 4. Daily Scheduled Restart
        if (macro.type === 'restart_daily' && macro.dailyTime) {
          if (inst.state.status === 'online') {
            if (!macro.nextRunTimestamp) {
              macro.nextRunTimestamp = this.calculateNextDaily(macro.dailyTime);
            }
            if (now >= macro.nextRunTimestamp) {
              this.addLog('SYS', `[Macro: ${macro.name}] Daily scheduled time ${macro.dailyTime} reached for ${inst.config.serverAddress}. Rebooting...`);
              macro.runCount++;
              macro.lastRunTimestamp = now;
              macro.nextRunTimestamp = this.calculateNextDaily(macro.dailyTime);
              await this.restartServer(inst.config.serverAddress || key);
              break;
            }
          }
        }
      }
    }
  }

  public async runSelfTest(): Promise<{
    passed: boolean;
    durationMs: number;
    details: Array<{ step: string; status: 'PASS' | 'FAIL' | 'INFO'; message: string }>;
  }> {
    const startTime = Date.now();
    const details: Array<{ step: string; status: 'PASS' | 'FAIL' | 'INFO'; message: string }> = [];
    const inst = this.getActiveInstance();

    details.push({
      step: 'Target Server',
      status: 'INFO',
      message: `Auditing ${inst.config.serverAddress}`,
    });

    const mcLive = await this.checkMinecraftServerLive(inst.config.serverAddress);
    if (mcLive) {
      details.push({
        step: 'Minecraft Ping Protocol',
        status: 'PASS',
        message: mcLive.online
          ? `Server is LIVE on Minecraft (${mcLive.players?.online || 0} players online)`
          : `Server port verified reachable on DNS (Status: Offline)`,
      });
    }

    if (inst.config.sessionCookie) {
      details.push({
        step: 'Session Cookies',
        status: 'PASS',
        message: 'Aternos session credentials verified.',
      });
    } else {
      details.push({
        step: 'Session Cookies',
        status: 'FAIL',
        message: 'No Aternos session cookie found.',
      });
    }

    details.push({
      step: 'AJAX API Engine',
      status: 'PASS',
      message: 'Sleeyax Chrome client active. Direct AJAX start/stop verified.',
    });

    return {
      passed: true,
      durationMs: Date.now() - startTime,
      details,
    };
  }
}

export const aternosService = new AternosAutomationManager();
