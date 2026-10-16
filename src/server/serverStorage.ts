import fs from 'fs';
import path from 'path';
import type { ServerProfile } from '../types/aternos.ts';
import { redis, DATA_PREFIX, GLOBAL_KEYS, CURRENT_ENV, getRedisJson, setRedisJson } from './redisClient.ts';

export interface StoredServerProfile extends ServerProfile {
  source?: 'web' | 'discord' | 'admin';
  discordUser?: string;
  discordGuild?: string;
  createdAt?: number;
  lastUpdated?: number;
}

export interface DiscordActivityLog {
  id: string;
  timestamp: string;
  user: string;
  command: string;
  serverAddress: string;
  status: 'success' | 'warning' | 'error';
  message: string;
}

export interface DiscordServerBinding {
  guildIdOrUserId: string;
  serverAddress: string;
  sessionCookie: string;
  serverCookie: string;
  configuredBy: string;
  updatedAt: number;
}

class ServerStorageManager {
  private dataDir: string;
  private storageFilePath: string;
  private discordBindingsPath: string;
  private discordLogsPath: string;
  private botModePath: string;
  private botTokenPath: string;

  private profiles: Map<string, StoredServerProfile> = new Map();
  private discordBindings: Map<string, DiscordServerBinding> = new Map();
  private discordLogs: DiscordActivityLog[] = [];
  private botToken: string = '';
  private botClientId: string = '';
  private userSessions: Map<string, string> = new Map();
  // Persisted pending selection menus so bot restarts or high traffic never cause "session expired" errors
  private pendingSelections: Map<string, { data: any; expiresAt: number }> = new Map();
  private changeListeners: Set<() => void> = new Set();
  // Default to published in production so apexion.ai.studio is the primary active bot
  private botTarget: 'dev' | 'published' | 'disabled' = CURRENT_ENV === 'published' ? 'published' : 'published';
  private readonly MAX_LOGS = 100;
  private isRedisLoaded: boolean = false;

  constructor() {
    this.dataDir = path.resolve(process.cwd(), 'data');
    this.storageFilePath = path.join(this.dataDir, 'admin-servers.json');
    this.discordBindingsPath = path.join(this.dataDir, 'discord-bindings.json');
    this.discordLogsPath = path.join(this.dataDir, 'discord-logs.json');
    this.botModePath = path.join(this.dataDir, 'bot-mode.json');
    this.botTokenPath = path.join(this.dataDir, 'bot-token.json');

    this.ensureDataDir();
    this.loadFromDisk();
    this.initUpstashRedis().catch(() => {});
  }

  private ensureDataDir() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
    } catch (err: any) {
      console.warn('Could not create data dir:', err?.message);
    }
  }

  /**
   * Load data from Upstash Redis on startup and periodically sync
   */
  private async initUpstashRedis() {
    try {
      console.log(`[Upstash Redis] Connecting with prefix "${DATA_PREFIX}" (${CURRENT_ENV.toUpperCase()})...`);
      
      // 1. Fetch server profiles from Upstash Redis
      const redisProfiles = await getRedisJson<StoredServerProfile[]>(`${DATA_PREFIX}servers`, []);
      if (Array.isArray(redisProfiles) && redisProfiles.length > 0) {
        for (const p of redisProfiles) {
          if (p.id) this.profiles.set(p.id, p);
        }
        console.log(`[Upstash Redis] Restored ${redisProfiles.length} server profile(s) from persistent store.`);
        this.saveToDisk();
      } else if (this.profiles.size > 0) {
        // First boot with existing local data: seed into Upstash
        await this.syncProfilesToRedis();
      }

      // 2. Fetch Discord bindings from Upstash Redis
      const redisBindings = await getRedisJson<DiscordServerBinding[]>(`${DATA_PREFIX}discord_bindings`, []);
      if (Array.isArray(redisBindings) && redisBindings.length > 0) {
        for (const b of redisBindings) {
          if (b.guildIdOrUserId) this.discordBindings.set(b.guildIdOrUserId, b);
        }
        console.log(`[Upstash Redis] Restored ${redisBindings.length} Discord binding(s).`);
        this.saveDiscordBindingsToDisk();
      } else if (this.discordBindings.size > 0) {
        await this.syncDiscordBindingsToRedis();
      }

      // 3. Fetch Discord logs from Upstash Redis
      const redisLogs = await getRedisJson<DiscordActivityLog[]>(`${DATA_PREFIX}discord_logs`, []);
      if (Array.isArray(redisLogs) && redisLogs.length > 0) {
        this.discordLogs = redisLogs;
      }

      // 4. Fetch global bot mode from Upstash Redis
      const globalBotMode = await getRedisJson<string>(GLOBAL_KEYS.BOT_MODE, '');
      if (globalBotMode === 'dev' || globalBotMode === 'published' || globalBotMode === 'disabled') {
        this.botTarget = globalBotMode;
        console.log(`[Upstash Redis] Coordinated bot mode is: "${this.botTarget}"`);
      } else {
        // Set default to published so apexion.ai.studio is primary
        await setRedisJson(GLOBAL_KEYS.BOT_MODE, 'published');
        this.botTarget = 'published';
      }

      // 5. Fetch custom bot token from Upstash Redis if configured
      const redisBotConfig = await getRedisJson<{ token?: string; clientId?: string } | string | null>(`${DATA_PREFIX}bot_token_config`, null);
      if (redisBotConfig) {
        if (typeof redisBotConfig === 'string' && redisBotConfig.trim()) {
          this.botToken = redisBotConfig.trim();
        } else if (typeof redisBotConfig === 'object' && redisBotConfig.token) {
          this.botToken = redisBotConfig.token.trim();
          if (redisBotConfig.clientId) {
            this.botClientId = redisBotConfig.clientId.trim();
          }
        }
        console.log('[Upstash Redis] Restored custom Discord bot credentials.');
      } else {
        const legacyToken = await getRedisJson<string | null>(`${DATA_PREFIX}bot_token`, null);
        if (legacyToken && typeof legacyToken === 'string' && legacyToken.trim()) {
          this.botToken = legacyToken.trim();
        }
      }

      this.isRedisLoaded = true;
    } catch (err: any) {
      console.warn('[Upstash Redis] Init sync warning:', err?.message);
    }
  }

  private async syncProfilesToRedis() {
    try {
      const list = Array.from(this.profiles.values());
      await setRedisJson(`${DATA_PREFIX}servers`, list);
    } catch {}
  }

  private async syncDiscordBindingsToRedis() {
    try {
      const list = Array.from(this.discordBindings.values());
      await setRedisJson(`${DATA_PREFIX}discord_bindings`, list);
    } catch {}
  }

  private async syncDiscordLogsToRedis() {
    try {
      await setRedisJson(`${DATA_PREFIX}discord_logs`, this.discordLogs);
    } catch {}
  }

  private loadFromDisk() {
    // 1. Load profiles from data/admin-servers.json or servers-config.json
    try {
      if (fs.existsSync(this.storageFilePath)) {
        const raw = fs.readFileSync(this.storageFilePath, 'utf-8');
        const list: StoredServerProfile[] = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item.id) this.profiles.set(item.id, item);
          }
        }
      } else if (fs.existsSync('./servers-config.json')) {
        const raw = fs.readFileSync('./servers-config.json', 'utf-8');
        const list: StoredServerProfile[] = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item.id) this.profiles.set(item.id, { ...item, source: 'web' });
          }
        }
      }
    } catch (err: any) {
      console.warn('Could not load stored server profiles:', err?.message);
    }

    // 2. Load Discord bindings
    try {
      if (fs.existsSync(this.discordBindingsPath)) {
        const raw = fs.readFileSync(this.discordBindingsPath, 'utf-8');
        const list: DiscordServerBinding[] = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item.guildIdOrUserId) this.discordBindings.set(item.guildIdOrUserId, item);
          }
        }
      }
    } catch {}

    // 3. Load Discord logs
    try {
      if (fs.existsSync(this.discordLogsPath)) {
        const raw = fs.readFileSync(this.discordLogsPath, 'utf-8');
        const list: DiscordActivityLog[] = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.discordLogs = list;
        }
      }

      // 4. Load bot active target
      if (fs.existsSync(this.botModePath)) {
        const raw = fs.readFileSync(this.botModePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed?.activeTarget === 'dev' || parsed?.activeTarget === 'published' || parsed?.activeTarget === 'disabled') {
          this.botTarget = parsed.activeTarget;
        }
      }

      // 5. Load custom bot token from disk
      if (fs.existsSync(this.botTokenPath)) {
        const raw = fs.readFileSync(this.botTokenPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed?.token) {
          this.botToken = parsed.token.trim();
        }
        if (parsed?.clientId) {
          this.botClientId = parsed.clientId.trim();
        }
      }
    } catch {}
  }

  private saveToDisk() {
    try {
      this.ensureDataDir();
      const list = Array.from(this.profiles.values());
      fs.writeFileSync(this.storageFilePath, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err: any) {
      console.warn('Could not save server profiles to disk:', err?.message);
    }
  }

  private saveDiscordBindingsToDisk() {
    try {
      this.ensureDataDir();
      const list = Array.from(this.discordBindings.values());
      fs.writeFileSync(this.discordBindingsPath, JSON.stringify(list, null, 2), 'utf-8');
    } catch {}
  }

  private saveDiscordLogsToDisk() {
    try {
      this.ensureDataDir();
      fs.writeFileSync(this.discordLogsPath, JSON.stringify(this.discordLogs, null, 2), 'utf-8');
    } catch {}
  }

  public getAllProfiles(): StoredServerProfile[] {
    return Array.from(this.profiles.values());
  }

  public getProfile(idOrAddress: string): StoredServerProfile | undefined {
    if (!idOrAddress) return undefined;
    if (this.profiles.has(idOrAddress)) return this.profiles.get(idOrAddress);
    const clean = idOrAddress.trim().toLowerCase();
    const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '').replace(/\.aternos\.me$/i, '');
    const normTarget = normalize(clean);

    for (const p of this.profiles.values()) {
      if (
        p.id.toLowerCase() === clean ||
        p.serverIp.toLowerCase() === clean ||
        p.name.toLowerCase() === clean ||
        normalize(p.id) === normTarget ||
        normalize(p.serverIp) === normTarget ||
        normalize(p.name) === normTarget
      ) {
        return p;
      }
    }
    return undefined;
  }

  public saveProfile(profile: StoredServerProfile): StoredServerProfile {
    const canonicalAddr = this.getCanonicalServerAddress(profile.serverIp || profile.name);
    const existing = this.getProfile(profile.id) || this.getProfile(canonicalAddr);
    const id = existing ? existing.id : profile.id || `srv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    // Remove any older duplicate entry with different ID for same canonical address
    if (existing && existing.id !== id) {
      this.profiles.delete(existing.id);
    }
    
    // Merge macros safely: never wipe enabled macros with an empty array or undefined
    let mergedMacros = existing?.macros;
    if (Array.isArray(profile.macros) && profile.macros.length > 0) {
      if (Array.isArray(existing?.macros) && existing.macros.length > 0) {
        mergedMacros = profile.macros.map(m => {
          const ex = existing.macros!.find(e => e.id === m.id);
          return { ...ex, ...m };
        });
      } else {
        mergedMacros = profile.macros;
      }
    }

    const software = profile.software || existing?.software || 'Paper / Bukkit';
    const port = profile.serverPort || existing?.serverPort || '25565';
    const version = profile.version || existing?.version || '1.20.4';

    const merged: StoredServerProfile = {
      ...existing,
      ...profile,
      id,
      serverIp: canonicalAddr || profile.serverIp,
      software,
      serverPort: port,
      version,
      macros: mergedMacros,
      createdAt: existing?.createdAt || Date.now(),
      lastUpdated: Date.now(),
    };
    this.profiles.set(id, merged);
    this.saveToDisk();
    this.syncProfilesToRedis().catch(() => {});
    this.notifyChange();
    return merged;
  }

  public syncFromClient(clientProfiles: ServerProfile[], source: 'web' | 'discord' = 'web'): void {
    if (!Array.isArray(clientProfiles)) return;
    for (const cp of clientProfiles) {
      if (!cp.serverIp && !cp.name) continue;
      const canonicalAddr = this.getCanonicalServerAddress(cp.serverIp || cp.name);
      const existing = this.getProfile(cp.id) || this.getProfile(canonicalAddr);
      const id = existing ? existing.id : cp.id || `srv-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

      if (existing && existing.id !== id) {
        this.profiles.delete(existing.id);
      }
      
      const sessionCookie = cp.sessionCookie && !cp.sessionCookie.includes('...') ? cp.sessionCookie : existing?.sessionCookie || '';
      const serverCookie = cp.serverCookie || existing?.serverCookie || '';

      const software = cp.software || existing?.software || 'Paper / Bukkit';
      const port = cp.serverPort || existing?.serverPort || '25565';
      const version = cp.version || existing?.version || '1.20.4';

      const updated: StoredServerProfile = {
        ...existing,
        ...cp,
        id,
        serverIp: canonicalAddr || cp.serverIp,
        software,
        serverPort: port,
        version,
        sessionCookie,
        serverCookie,
        source: existing?.source || source,
        createdAt: existing?.createdAt || Date.now(),
        lastUpdated: Date.now(),
      };
      this.profiles.set(id, updated);
    }
    this.saveToDisk();
    this.syncProfilesToRedis().catch(() => {});
    this.notifyChange();
  }

  public deleteProfile(id: string): boolean {
    const profile = this.getProfile(id);
    if (!profile) return false;
    this.profiles.delete(profile.id);
    this.saveToDisk();
    this.syncProfilesToRedis().catch(() => {});
    this.notifyChange();
    return true;
  }

  // Canonical server address lookup preserving proper casing
  public getCanonicalServerAddress(query: string): string {
    if (!query) return '';
    const clean = query.trim();
    const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '').replace(/\.aternos\.me$/i, '');
    const norm = normalize(clean);

    if (norm === 'bangbros' || norm.startsWith('bangbro') || norm.includes('bangbros') || norm.includes('bangbrossmp')) {
      return 'Bang_Bros_SMP.aternos.me';
    }
    if (norm === 'narendramundi' || norm.includes('narendramundi')) {
      return 'Narendra_Mundi.aternos.me';
    }

    for (const p of this.profiles.values()) {
      if (
        p.serverIp.toLowerCase() === clean.toLowerCase() ||
        p.name.toLowerCase() === clean.toLowerCase() ||
        normalize(p.serverIp) === norm ||
        normalize(p.name) === norm ||
        (norm.length >= 4 && (normalize(p.serverIp).includes(norm) || norm.includes(normalize(p.serverIp))))
      ) {
        return p.serverIp || p.name;
      }
    }
    for (const b of this.discordBindings.values()) {
      if (
        b.serverAddress.toLowerCase() === clean.toLowerCase() ||
        normalize(b.serverAddress) === norm ||
        (norm.length >= 4 && (normalize(b.serverAddress).includes(norm) || norm.includes(normalize(b.serverAddress))))
      ) {
        return b.serverAddress;
      }
    }
    return clean;
  }

  // Robust Server Cookie lookup for a given server address
  public getServerCookie(address: string): string | undefined {
    if (!address) return undefined;
    const p = this.getProfile(address);
    if (p?.serverCookie) return p.serverCookie;

    const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '').replace(/\.aternos\.me$/i, '');
    const norm = normalize(address);

    for (const prof of this.profiles.values()) {
      if (
        prof.serverIp.toLowerCase() === address.toLowerCase() ||
        prof.name.toLowerCase() === address.toLowerCase() ||
        normalize(prof.serverIp) === norm ||
        normalize(prof.name) === norm
      ) {
        if (prof.serverCookie) return prof.serverCookie;
      }
    }
    for (const b of this.discordBindings.values()) {
      if (
        b.serverAddress.toLowerCase() === address.toLowerCase() ||
        normalize(b.serverAddress) === norm
      ) {
        if (b.serverCookie) return b.serverCookie;
      }
    }
    return undefined;
  }

  public setServerCookie(address: string, serverCookie: string): void {
    if (!address || !serverCookie) return;
    const p = this.getProfile(address);
    if (p) {
      this.saveProfile({
        ...p,
        serverCookie,
      });
    }
  }

  public findProfileByServerCookie(cookieOrId: string): StoredServerProfile | undefined {
    if (!cookieOrId) return undefined;
    const clean = cookieOrId.trim().toLowerCase();
    for (const p of this.profiles.values()) {
      if (
        (p.serverCookie && p.serverCookie.toLowerCase() === clean) ||
        (p.id && p.id.toLowerCase() === clean)
      ) {
        return p;
      }
    }
    return undefined;
  }

  // Pending Discord server select menus (persisted across bot restarts, container recycles, and high load)
  public setPendingSelection(key: string, data: any, ttlSeconds: number = 3600): void {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.pendingSelections.set(key, { data, expiresAt });
    setRedisJson(`${DATA_PREFIX}pending_select:${key}`, { data, expiresAt }, ttlSeconds).catch(() => {});
  }

  public async getPendingSelection(key: string): Promise<any | undefined> {
    const local = this.pendingSelections.get(key);
    if (local) {
      if (local.expiresAt > Date.now()) {
        return local.data;
      }
      this.pendingSelections.delete(key);
    }
    const redisVal = await getRedisJson<{ data: any; expiresAt: number } | null>(`${DATA_PREFIX}pending_select:${key}`, null);
    if (redisVal && redisVal.expiresAt > Date.now()) {
      this.pendingSelections.set(key, redisVal);
      return redisVal.data;
    }
    return undefined;
  }

  public deletePendingSelection(key: string): void {
    this.pendingSelections.delete(key);
    setRedisJson(`${DATA_PREFIX}pending_select:${key}`, null, 1).catch(() => {});
  }

  public onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {}
    }
  }

  // Discord Bindings
  public setDiscordBinding(binding: DiscordServerBinding): void {
    const canonicalAddr = this.getCanonicalServerAddress(binding.serverAddress);
    const updatedBinding = { ...binding, serverAddress: canonicalAddr };
    this.discordBindings.set(binding.guildIdOrUserId, updatedBinding);
    this.saveDiscordBindingsToDisk();
    this.syncDiscordBindingsToRedis().catch(() => {});

    // Also register or update server profile in general storage
    const id = `discord-${canonicalAddr.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
    const existing = this.getProfile(id) || this.getProfile(canonicalAddr);
    this.saveProfile({
      id,
      name: canonicalAddr,
      serverIp: canonicalAddr,
      serverPort: existing?.serverPort || '25565',
      software: existing?.software || 'Fabric',
      version: existing?.version || '1.20.4',
      sessionCookie: binding.sessionCookie,
      serverCookie: binding.serverCookie,
      source: 'discord',
      discordUser: binding.configuredBy,
    });
    this.notifyChange();
  }

  public getDiscordBinding(id: string): DiscordServerBinding | undefined {
    if (!id) return undefined;
    if (this.discordBindings.has(id)) {
      return this.discordBindings.get(id);
    }
    return undefined;
  }

  public getAllDiscordBindings(): DiscordServerBinding[] {
    return Array.from(this.discordBindings.values());
  }

  // Discord Logs
  public addDiscordLog(entry: Omit<DiscordActivityLog, 'id' | 'timestamp'>): void {
    const log: DiscordActivityLog = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
    };
    this.discordLogs.unshift(log);
    if (this.discordLogs.length > this.MAX_LOGS) {
      this.discordLogs.pop();
    }
    this.saveDiscordLogsToDisk();
    this.syncDiscordLogsToRedis().catch(() => {});
  }

  public getDiscordLogs(): DiscordActivityLog[] {
    return [...this.discordLogs];
  }

  // Discord Bot Active Instance Target ('dev' | 'published' | 'disabled')
  public getBotTarget(): 'dev' | 'published' | 'disabled' {
    return this.botTarget;
  }

  public async setBotTarget(target: 'dev' | 'published' | 'disabled', updatedBy: string = 'Admin'): Promise<void> {
    this.botTarget = target;
    try {
      this.ensureDataDir();
      fs.writeFileSync(
        this.botModePath,
        JSON.stringify(
          {
            activeTarget: target,
            updatedAt: Date.now(),
            updatedBy,
          },
          null,
          2
        ),
        'utf-8'
      );
      // Persist globally in Upstash Redis so both dev and published instances see it immediately
      await setRedisJson(GLOBAL_KEYS.BOT_MODE, target);
    } catch (err: any) {
      console.warn('Could not save bot mode to Upstash/disk:', err?.message);
    }
  }

  // Discord Bot Token & Credentials Configuration
  public getBotToken(): string {
    return this.botToken;
  }

  public getBotClientId(): string {
    return this.botClientId;
  }

  public async setBotCredentials(token: string, clientId?: string): Promise<void> {
    const cleanToken = (token || '').trim();
    let cleanClientId = (clientId || '').trim();

    // Auto-extract clientId from Discord bot token if not provided (first part of token is base64 encoded client ID)
    if (!cleanClientId && cleanToken.includes('.')) {
      try {
        const firstPart = cleanToken.split('.')[0];
        const decoded = Buffer.from(firstPart, 'base64').toString('ascii');
        if (/^\d{17,20}$/.test(decoded)) {
          cleanClientId = decoded;
        }
      } catch {}
    }

    this.botToken = cleanToken;
    if (cleanClientId) {
      this.botClientId = cleanClientId;
    }

    try {
      this.ensureDataDir();
      fs.writeFileSync(
        this.botTokenPath,
        JSON.stringify(
          {
            token: this.botToken,
            clientId: this.botClientId,
            updatedAt: Date.now(),
          },
          null,
          2
        ),
        'utf-8'
      );

      // Persist globally in Upstash Redis
      await setRedisJson(`${DATA_PREFIX}bot_token_config`, {
        token: this.botToken,
        clientId: this.botClientId,
        updatedAt: Date.now(),
      });
      console.log('[ServerStorage] Saved Discord bot credentials to disk and Upstash Redis.');
    } catch (err: any) {
      console.warn('Could not persist bot credentials:', err?.message);
    }
  }

  // User session cache for resilient /configure operations
  public saveUserSession(userId: string, session: string): void {
    if (!userId || !session) return;
    this.userSessions.set(userId, session);
    setRedisJson(`${DATA_PREFIX}user_session:${userId}`, session, 86400 * 7).catch(() => {});
  }

  public async getUserSession(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;
    const local = this.userSessions.get(userId);
    if (local) return local;
    const redisVal = await getRedisJson<string | null>(`${DATA_PREFIX}user_session:${userId}`, null);
    if (redisVal) {
      this.userSessions.set(userId, redisVal);
      return redisVal;
    }
    return undefined;
  }
}

export const serverStorage = new ServerStorageManager();
