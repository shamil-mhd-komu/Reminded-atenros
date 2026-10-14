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

  private profiles: Map<string, StoredServerProfile> = new Map();
  private discordBindings: Map<string, DiscordServerBinding> = new Map();
  private discordLogs: DiscordActivityLog[] = [];
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
    } catch {}
  }

  private saveToDisk() {
    try {
      this.ensureDataDir();
      const list = Array.from(this.profiles.values());
      fs.writeFileSync(this.storageFilePath, JSON.stringify(list, null, 2), 'utf-8');
      fs.writeFileSync('./servers-config.json', JSON.stringify(list, null, 2), 'utf-8');
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
    const existing = this.profiles.get(profile.id) || this.getProfile(profile.serverIp);
    const id = existing ? existing.id : profile.id || `srv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const merged: StoredServerProfile = {
      ...existing,
      ...profile,
      id,
      createdAt: existing?.createdAt || Date.now(),
      lastUpdated: Date.now(),
    };
    this.profiles.set(id, merged);
    this.saveToDisk();
    this.syncProfilesToRedis().catch(() => {});
    return merged;
  }

  public syncFromClient(clientProfiles: ServerProfile[], source: 'web' | 'discord' = 'web'): void {
    if (!Array.isArray(clientProfiles)) return;
    for (const cp of clientProfiles) {
      if (!cp.serverIp && !cp.name) continue;
      const existing = this.getProfile(cp.id) || this.getProfile(cp.serverIp);
      const id = existing ? existing.id : cp.id || `srv-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      
      const sessionCookie = cp.sessionCookie && !cp.sessionCookie.includes('...') ? cp.sessionCookie : existing?.sessionCookie || '';
      const serverCookie = cp.serverCookie || existing?.serverCookie || '';

      const updated: StoredServerProfile = {
        ...existing,
        ...cp,
        id,
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
  }

  public deleteProfile(id: string): boolean {
    const profile = this.getProfile(id);
    if (!profile) return false;
    this.profiles.delete(profile.id);
    this.saveToDisk();
    this.syncProfilesToRedis().catch(() => {});
    return true;
  }

  // Canonical server address lookup preserving proper casing
  public getCanonicalServerAddress(query: string): string {
    if (!query) return 'Bang_Bros_SMP.aternos.me';
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

  // Discord Bindings
  public setDiscordBinding(binding: DiscordServerBinding): void {
    const canonicalAddr = this.getCanonicalServerAddress(binding.serverAddress);
    const updatedBinding = { ...binding, serverAddress: canonicalAddr };
    this.discordBindings.set(binding.guildIdOrUserId, updatedBinding);
    this.saveDiscordBindingsToDisk();
    this.syncDiscordBindingsToRedis().catch(() => {});

    // Also register or update server profile in general storage
    const id = `discord-${canonicalAddr.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
    this.saveProfile({
      id,
      name: canonicalAddr,
      serverIp: canonicalAddr,
      serverPort: '25565',
      software: 'Paper / Bukkit',
      version: '1.20.4',
      sessionCookie: binding.sessionCookie,
      serverCookie: binding.serverCookie,
      source: 'discord',
      discordUser: binding.configuredBy,
    });
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
}

export const serverStorage = new ServerStorageManager();
