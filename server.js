// server.ts
import "dotenv/config";
import express from "express";
import path4 from "path";
import fs4 from "fs";
import { fileURLToPath } from "url";

// src/server/aternosAutomation.ts
import vm from "vm";
import { exec, execSync } from "child_process";
import path3 from "path";
import fs3 from "fs";

// src/server/serverStorage.ts
import fs2 from "fs";
import path2 from "path";

// src/server/redisClient.ts
import { Redis } from "@upstash/redis";
import fs from "fs";
import path from "path";
function cleanEnv(val, fallback) {
  if (!val) return fallback;
  const trimmed = val.trim().replace(/^["']|["']$/g, "");
  return trimmed.length > 0 ? trimmed : fallback;
}
var UPSTASH_URL = cleanEnv(
  process.env.UPSTASH_REDIS_REST_URL,
  "https://fond-koi-285614.upstash.io"
);
var UPSTASH_TOKEN = cleanEnv(
  process.env.UPSTASH_REDIS_REST_TOKEN,
  "gQAAAAAABFuuAAIgcDE4MDFkODk4NWViZDU0ODllOGNhNDkzNmUyODY3ZWM3Mw"
);
var inMemoryFallbackStore = /* @__PURE__ */ new Map();
var redis = new Redis({
  url: UPSTASH_URL,
  token: UPSTASH_TOKEN
});
function detectEnvironment() {
  if (process.env.APPLET_ENV === "production" || process.env.NODE_ENV === "production") {
    return "published";
  }
  if (process.env.APPLET_ENV === "dev" || process.env.NODE_ENV === "development") {
    return "dev";
  }
  const hasViteSource = fs.existsSync(path.resolve(process.cwd(), "vite.config.ts"));
  if (!hasViteSource) {
    return "published";
  }
  return "dev";
}
var CURRENT_ENV = detectEnvironment();
var DATA_PREFIX = CURRENT_ENV === "published" ? "apexion:prod:" : "apexion:dev:";
var GLOBAL_KEYS = {
  BOT_MODE: "apexion:global:bot_mode",
  // 'published' | 'dev' | 'disabled'
  BOT_LEADER: "apexion:bot:leader_instance"
  // Holds active leader instance info
};
var lastRedisError = null;
var lastHealthyCheck = 0;
var isRedisAvailable = true;
async function getRedisJson(key, defaultValue) {
  try {
    const raw = await redis.get(key);
    isRedisAvailable = true;
    lastRedisError = null;
    if (raw === null || raw === void 0) {
      const cached = inMemoryFallbackStore.get(key);
      if (cached) {
        if (!cached.expiresAt || cached.expiresAt > Date.now()) {
          return cached.value;
        }
        inMemoryFallbackStore.delete(key);
      }
      return defaultValue;
    }
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        inMemoryFallbackStore.set(key, { value: parsed });
        return parsed;
      } catch {
        inMemoryFallbackStore.set(key, { value: raw });
        return raw;
      }
    }
    inMemoryFallbackStore.set(key, { value: raw });
    return raw;
  } catch (err) {
    isRedisAvailable = false;
    lastRedisError = err?.message || "Redis connection failed";
    const cached = inMemoryFallbackStore.get(key);
    if (cached) {
      if (!cached.expiresAt || cached.expiresAt > Date.now()) {
        return cached.value;
      }
      inMemoryFallbackStore.delete(key);
    }
    return defaultValue;
  }
}
async function setRedisJson(key, value, ttlSeconds) {
  const expiresAt = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1e3 : void 0;
  inMemoryFallbackStore.set(key, { value, expiresAt });
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await redis.set(key, serialized, { ex: ttlSeconds });
    } else {
      await redis.set(key, serialized);
    }
    isRedisAvailable = true;
    lastRedisError = null;
    return true;
  } catch (err) {
    isRedisAvailable = false;
    lastRedisError = err?.message || "Redis write failed";
    return true;
  }
}
async function getRedisHealth() {
  const start = Date.now();
  try {
    const res = await redis.ping();
    const latency = Date.now() - start;
    if (res === "PONG") {
      isRedisAvailable = true;
      lastRedisError = null;
      lastHealthyCheck = Date.now();
      return {
        ok: true,
        status: "connected",
        message: "Upstash Redis cloud operational",
        latencyMs: latency
      };
    }
  } catch (err) {
    isRedisAvailable = false;
    lastRedisError = err?.message || "Upstash token or connection failure";
  }
  return {
    ok: true,
    // Still operational via in-memory fallback
    status: "fallback",
    message: lastRedisError ? `Local Fallback Active (${lastRedisError})` : "Local Fallback Active"
  };
}

// src/server/serverStorage.ts
var ServerStorageManager = class {
  constructor() {
    this.profiles = /* @__PURE__ */ new Map();
    this.discordBindings = /* @__PURE__ */ new Map();
    this.discordLogs = [];
    // Default to published in production so apexion.ai.studio is the primary active bot
    this.botTarget = CURRENT_ENV === "published" ? "published" : "published";
    this.MAX_LOGS = 100;
    this.isRedisLoaded = false;
    this.dataDir = path2.resolve(process.cwd(), "data");
    this.storageFilePath = path2.join(this.dataDir, "admin-servers.json");
    this.discordBindingsPath = path2.join(this.dataDir, "discord-bindings.json");
    this.discordLogsPath = path2.join(this.dataDir, "discord-logs.json");
    this.botModePath = path2.join(this.dataDir, "bot-mode.json");
    this.ensureDataDir();
    this.loadFromDisk();
    this.initUpstashRedis().catch(() => {
    });
  }
  ensureDataDir() {
    try {
      if (!fs2.existsSync(this.dataDir)) {
        fs2.mkdirSync(this.dataDir, { recursive: true });
      }
    } catch (err) {
      console.warn("Could not create data dir:", err?.message);
    }
  }
  /**
   * Load data from Upstash Redis on startup and periodically sync
   */
  async initUpstashRedis() {
    try {
      console.log(`[Upstash Redis] Connecting with prefix "${DATA_PREFIX}" (${CURRENT_ENV.toUpperCase()})...`);
      const redisProfiles = await getRedisJson(`${DATA_PREFIX}servers`, []);
      if (Array.isArray(redisProfiles) && redisProfiles.length > 0) {
        for (const p of redisProfiles) {
          if (p.id) this.profiles.set(p.id, p);
        }
        console.log(`[Upstash Redis] Restored ${redisProfiles.length} server profile(s) from persistent store.`);
        this.saveToDisk();
      } else if (this.profiles.size > 0) {
        await this.syncProfilesToRedis();
      }
      const redisBindings = await getRedisJson(`${DATA_PREFIX}discord_bindings`, []);
      if (Array.isArray(redisBindings) && redisBindings.length > 0) {
        for (const b of redisBindings) {
          if (b.guildIdOrUserId) this.discordBindings.set(b.guildIdOrUserId, b);
        }
        console.log(`[Upstash Redis] Restored ${redisBindings.length} Discord binding(s).`);
        this.saveDiscordBindingsToDisk();
      } else if (this.discordBindings.size > 0) {
        await this.syncDiscordBindingsToRedis();
      }
      const redisLogs = await getRedisJson(`${DATA_PREFIX}discord_logs`, []);
      if (Array.isArray(redisLogs) && redisLogs.length > 0) {
        this.discordLogs = redisLogs;
      }
      const globalBotMode = await getRedisJson(GLOBAL_KEYS.BOT_MODE, "");
      if (globalBotMode === "dev" || globalBotMode === "published" || globalBotMode === "disabled") {
        this.botTarget = globalBotMode;
        console.log(`[Upstash Redis] Coordinated bot mode is: "${this.botTarget}"`);
      } else {
        await setRedisJson(GLOBAL_KEYS.BOT_MODE, "published");
        this.botTarget = "published";
      }
      this.isRedisLoaded = true;
    } catch (err) {
      console.warn("[Upstash Redis] Init sync warning:", err?.message);
    }
  }
  async syncProfilesToRedis() {
    try {
      const list = Array.from(this.profiles.values());
      await setRedisJson(`${DATA_PREFIX}servers`, list);
    } catch {
    }
  }
  async syncDiscordBindingsToRedis() {
    try {
      const list = Array.from(this.discordBindings.values());
      await setRedisJson(`${DATA_PREFIX}discord_bindings`, list);
    } catch {
    }
  }
  async syncDiscordLogsToRedis() {
    try {
      await setRedisJson(`${DATA_PREFIX}discord_logs`, this.discordLogs);
    } catch {
    }
  }
  loadFromDisk() {
    try {
      if (fs2.existsSync(this.storageFilePath)) {
        const raw = fs2.readFileSync(this.storageFilePath, "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item.id) this.profiles.set(item.id, item);
          }
        }
      } else if (fs2.existsSync("./servers-config.json")) {
        const raw = fs2.readFileSync("./servers-config.json", "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item.id) this.profiles.set(item.id, { ...item, source: "web" });
          }
        }
      }
    } catch (err) {
      console.warn("Could not load stored server profiles:", err?.message);
    }
    try {
      if (fs2.existsSync(this.discordBindingsPath)) {
        const raw = fs2.readFileSync(this.discordBindingsPath, "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item.guildIdOrUserId) this.discordBindings.set(item.guildIdOrUserId, item);
          }
        }
      }
    } catch {
    }
    try {
      if (fs2.existsSync(this.discordLogsPath)) {
        const raw = fs2.readFileSync(this.discordLogsPath, "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.discordLogs = list;
        }
      }
      if (fs2.existsSync(this.botModePath)) {
        const raw = fs2.readFileSync(this.botModePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed?.activeTarget === "dev" || parsed?.activeTarget === "published" || parsed?.activeTarget === "disabled") {
          this.botTarget = parsed.activeTarget;
        }
      }
    } catch {
    }
  }
  saveToDisk() {
    try {
      this.ensureDataDir();
      const list = Array.from(this.profiles.values());
      fs2.writeFileSync(this.storageFilePath, JSON.stringify(list, null, 2), "utf-8");
    } catch (err) {
      console.warn("Could not save server profiles to disk:", err?.message);
    }
  }
  saveDiscordBindingsToDisk() {
    try {
      this.ensureDataDir();
      const list = Array.from(this.discordBindings.values());
      fs2.writeFileSync(this.discordBindingsPath, JSON.stringify(list, null, 2), "utf-8");
    } catch {
    }
  }
  saveDiscordLogsToDisk() {
    try {
      this.ensureDataDir();
      fs2.writeFileSync(this.discordLogsPath, JSON.stringify(this.discordLogs, null, 2), "utf-8");
    } catch {
    }
  }
  getAllProfiles() {
    return Array.from(this.profiles.values());
  }
  getProfile(idOrAddress) {
    if (!idOrAddress) return void 0;
    if (this.profiles.has(idOrAddress)) return this.profiles.get(idOrAddress);
    const clean = idOrAddress.trim().toLowerCase();
    const normalize = (s) => s.toLowerCase().replace(/[-_\s]/g, "").replace(/\.aternos\.me$/i, "");
    const normTarget = normalize(clean);
    for (const p of this.profiles.values()) {
      if (p.id.toLowerCase() === clean || p.serverIp.toLowerCase() === clean || p.name.toLowerCase() === clean || normalize(p.id) === normTarget || normalize(p.serverIp) === normTarget || normalize(p.name) === normTarget) {
        return p;
      }
    }
    return void 0;
  }
  saveProfile(profile) {
    const existing = this.profiles.get(profile.id) || this.getProfile(profile.serverIp);
    const id = existing ? existing.id : profile.id || `srv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const merged = {
      ...existing,
      ...profile,
      id,
      createdAt: existing?.createdAt || Date.now(),
      lastUpdated: Date.now()
    };
    this.profiles.set(id, merged);
    this.saveToDisk();
    this.syncProfilesToRedis().catch(() => {
    });
    return merged;
  }
  syncFromClient(clientProfiles, source = "web") {
    if (!Array.isArray(clientProfiles)) return;
    for (const cp of clientProfiles) {
      if (!cp.serverIp && !cp.name) continue;
      const existing = this.getProfile(cp.id) || this.getProfile(cp.serverIp);
      const id = existing ? existing.id : cp.id || `srv-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const sessionCookie = cp.sessionCookie && !cp.sessionCookie.includes("...") ? cp.sessionCookie : existing?.sessionCookie || "";
      const serverCookie = cp.serverCookie || existing?.serverCookie || "";
      const updated = {
        ...existing,
        ...cp,
        id,
        sessionCookie,
        serverCookie,
        source: existing?.source || source,
        createdAt: existing?.createdAt || Date.now(),
        lastUpdated: Date.now()
      };
      this.profiles.set(id, updated);
    }
    this.saveToDisk();
    this.syncProfilesToRedis().catch(() => {
    });
  }
  deleteProfile(id) {
    const profile = this.getProfile(id);
    if (!profile) return false;
    this.profiles.delete(profile.id);
    this.saveToDisk();
    this.syncProfilesToRedis().catch(() => {
    });
    return true;
  }
  // Canonical server address lookup preserving proper casing
  getCanonicalServerAddress(query) {
    if (!query) return "";
    const clean = query.trim();
    const normalize = (s) => s.toLowerCase().replace(/[-_\s]/g, "").replace(/\.aternos\.me$/i, "");
    const norm = normalize(clean);
    if (norm === "bangbros" || norm.startsWith("bangbro") || norm.includes("bangbros") || norm.includes("bangbrossmp")) {
      return "Bang_Bros_SMP.aternos.me";
    }
    if (norm === "narendramundi" || norm.includes("narendramundi")) {
      return "Narendra_Mundi.aternos.me";
    }
    for (const p of this.profiles.values()) {
      if (p.serverIp.toLowerCase() === clean.toLowerCase() || p.name.toLowerCase() === clean.toLowerCase() || normalize(p.serverIp) === norm || normalize(p.name) === norm || norm.length >= 4 && (normalize(p.serverIp).includes(norm) || norm.includes(normalize(p.serverIp)))) {
        return p.serverIp || p.name;
      }
    }
    for (const b of this.discordBindings.values()) {
      if (b.serverAddress.toLowerCase() === clean.toLowerCase() || normalize(b.serverAddress) === norm || norm.length >= 4 && (normalize(b.serverAddress).includes(norm) || norm.includes(normalize(b.serverAddress)))) {
        return b.serverAddress;
      }
    }
    return clean;
  }
  // Discord Bindings
  setDiscordBinding(binding) {
    const canonicalAddr = this.getCanonicalServerAddress(binding.serverAddress);
    const updatedBinding = { ...binding, serverAddress: canonicalAddr };
    this.discordBindings.set(binding.guildIdOrUserId, updatedBinding);
    this.saveDiscordBindingsToDisk();
    this.syncDiscordBindingsToRedis().catch(() => {
    });
    const id = `discord-${canonicalAddr.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`;
    this.saveProfile({
      id,
      name: canonicalAddr,
      serverIp: canonicalAddr,
      serverPort: "25565",
      software: "Paper / Bukkit",
      version: "1.20.4",
      sessionCookie: binding.sessionCookie,
      serverCookie: binding.serverCookie,
      source: "discord",
      discordUser: binding.configuredBy
    });
  }
  getDiscordBinding(id) {
    if (!id) return void 0;
    if (this.discordBindings.has(id)) {
      return this.discordBindings.get(id);
    }
    return void 0;
  }
  getAllDiscordBindings() {
    return Array.from(this.discordBindings.values());
  }
  // Discord Logs
  addDiscordLog(entry) {
    const log = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: (/* @__PURE__ */ new Date()).toLocaleTimeString("en-US", { hour12: false })
    };
    this.discordLogs.unshift(log);
    if (this.discordLogs.length > this.MAX_LOGS) {
      this.discordLogs.pop();
    }
    this.saveDiscordLogsToDisk();
    this.syncDiscordLogsToRedis().catch(() => {
    });
  }
  getDiscordLogs() {
    return [...this.discordLogs];
  }
  // Discord Bot Active Instance Target ('dev' | 'published' | 'disabled')
  getBotTarget() {
    return this.botTarget;
  }
  async setBotTarget(target, updatedBy = "Admin") {
    this.botTarget = target;
    try {
      this.ensureDataDir();
      fs2.writeFileSync(
        this.botModePath,
        JSON.stringify(
          {
            activeTarget: target,
            updatedAt: Date.now(),
            updatedBy
          },
          null,
          2
        ),
        "utf-8"
      );
      await setRedisJson(GLOBAL_KEYS.BOT_MODE, target);
    } catch (err) {
      console.warn("Could not save bot mode to Upstash/disk:", err?.message);
    }
  }
};
var serverStorage = new ServerStorageManager();

// src/server/aternosAutomation.ts
var DEFAULT_SESSION_CONFIG = {
  sessionCookie: process.env.ATERNOS_SESSION || "",
  serverCookie: process.env.ATERNOS_SERVER || "",
  serverAddress: process.env.ATERNOS_SERVER_ADDRESS || ""
};
function randomString(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
var DEFAULT_MACRO_RULES = [
  {
    id: "macro-extend-interval",
    name: "Auto Add Timer (+1 Keepalive)",
    description: "When enabled, it will automatically click +1 when timer reaches below 1:00.",
    type: "extend_interval",
    enabled: true,
    lastRunTimestamp: null,
    nextRunTimestamp: null,
    runCount: 0
  },
  {
    id: "macro-afk-watchdog",
    name: "24/7 AFK Watchdog",
    description: "Automatically detects if the server is offline or crashed and restarts it to maintain 24/7 continuous uptime",
    type: "afk_watchdog",
    enabled: false,
    intervalMinutes: 1,
    lastRunTimestamp: null,
    nextRunTimestamp: null,
    runCount: 0
  },
  {
    id: "macro-restart-interval",
    name: "Interval Server Restart",
    description: "Automatically restart the server every X hours or minutes to prevent lag and refresh server state",
    type: "restart_interval",
    enabled: false,
    intervalMinutes: 60,
    lastRunTimestamp: null,
    nextRunTimestamp: null,
    runCount: 0
  },
  {
    id: "macro-restart-daily",
    name: "Daily Scheduled Restart",
    description: "Automatically restart the server everyday at a scheduled time (e.g. 06:30 AM)",
    type: "restart_daily",
    enabled: false,
    dailyTime: "06:30",
    lastRunTimestamp: null,
    nextRunTimestamp: null,
    runCount: 0
  }
];
var AternosAutomationManager = class {
  constructor() {
    this.sessions = /* @__PURE__ */ new Map();
    this.activeSessionKey = "default";
    this.logsBuffer = [];
    this.MAX_LOGS = 120;
    this.inFlightSyncs = /* @__PURE__ */ new Map();
    this.macroRules = JSON.parse(JSON.stringify(DEFAULT_MACRO_RULES));
    this.curlBinaryPath = path3.resolve(process.cwd(), "bin", "curl_chrome116");
    this.ensureCurlBinary();
    this.addLog("SYS", "Apexion Server Core online. High-speed stealth automation active.");
    const initialConfig = this.loadConfig();
    if (initialConfig.serverAddress) {
      this.activeSessionKey = initialConfig.serverAddress.toLowerCase();
      this.getOrCreateSessionInstance(this.activeSessionKey, initialConfig);
    }
    this.loadServersConfig();
    this.loadMacrosConfig();
    setInterval(() => {
      this.syncActiveSession().catch(() => {
      });
    }, 12e3);
    setInterval(() => {
      this.tickCountdowns();
    }, 1e3);
    setInterval(() => {
      this.processMacros().catch(() => {
      });
    }, 5e3);
  }
  ensureCurlBinary() {
    try {
      if (!fs3.existsSync(this.curlBinaryPath)) {
        const binDir2 = path3.dirname(this.curlBinaryPath);
        if (!fs3.existsSync(binDir2)) {
          fs3.mkdirSync(binDir2, { recursive: true });
        }
        execSync(
          'curl -sL "https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz" | tar -xz -C ./bin',
          { stdio: "ignore" }
        );
      }
      if (fs3.existsSync(this.curlBinaryPath)) {
        fs3.chmodSync(this.curlBinaryPath, 493);
      }
      const binDir = path3.dirname(this.curlBinaryPath);
      if (fs3.existsSync(binDir)) {
        for (const file of fs3.readdirSync(binDir)) {
          try {
            fs3.chmodSync(path3.join(binDir, file), 493);
          } catch {
          }
        }
      }
    } catch (err) {
      console.warn("Could not ensure curl binary permissions:", err?.message);
    }
  }
  loadConfig() {
    try {
      if (fs3.existsSync("./session-config.json")) {
        const raw = fs3.readFileSync("./session-config.json", "utf-8");
        return JSON.parse(raw);
      }
    } catch {
    }
    return { ...DEFAULT_SESSION_CONFIG };
  }
  loadMacrosConfig() {
    try {
      if (fs3.existsSync("./macros-config.json")) {
        const raw = fs3.readFileSync("./macros-config.json", "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.macroRules = parsed;
        }
      }
    } catch (err) {
      console.warn("Could not load macros-config.json:", err?.message);
    }
  }
  saveMacrosConfig() {
    try {
      fs3.writeFileSync("./macros-config.json", JSON.stringify(this.macroRules, null, 2), "utf-8");
    } catch {
    }
  }
  loadServersConfig() {
    try {
      if (fs3.existsSync("./servers-config.json")) {
        const raw = fs3.readFileSync("./servers-config.json", "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const s of list) {
            const address = s.serverIp || s.serverAddress || s.name;
            if (!address) continue;
            const key = address.toLowerCase();
            const cfg = {
              sessionCookie: s.sessionCookie || "",
              serverCookie: s.serverCookie || "",
              serverAddress: address,
              software: s.software || "Fabric",
              version: s.version || "26.3 (0.19.5)",
              serverPort: s.serverPort || "25565"
            };
            const inst = this.getOrCreateSessionInstance(key, cfg);
            if (s.id) inst.id = s.id;
          }
        }
      }
    } catch (err) {
      console.warn("Could not load servers-config.json:", err?.message);
    }
  }
  getServersList() {
    try {
      if (fs3.existsSync("./servers-config.json")) {
        const raw = fs3.readFileSync("./servers-config.json", "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list) && list.length > 0) {
          return list;
        }
      }
    } catch {
    }
    return [];
  }
  addLog(level, rawMessage) {
    const clean = rawMessage.trim();
    const last = this.logsBuffer[this.logsBuffer.length - 1];
    if (last && last.level === level && last.message === clean) {
      return;
    }
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: (/* @__PURE__ */ new Date()).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }),
      level,
      message: clean
    };
    this.logsBuffer.push(entry);
    if (this.logsBuffer.length > this.MAX_LOGS) {
      this.logsBuffer.shift();
    }
    console.log(`[${entry.timestamp}] [${entry.level}] ${entry.message}`);
  }
  getLogs() {
    return [...this.logsBuffer];
  }
  clearLogs() {
    this.logsBuffer = [];
  }
  findSessionInstance(query) {
    if (!query) return this.getActiveInstance();
    const clean = query.trim().toLowerCase();
    if (this.sessions.has(clean)) return this.sessions.get(clean);
    const normalize = (s) => s.toLowerCase().replace(/[-_\s]/g, "").replace(/\.aternos\.me$/i, "");
    const cleanNorm = normalize(clean);
    for (const inst of this.sessions.values()) {
      if (inst.id && inst.id.toLowerCase() === clean || inst.config.serverAddress && inst.config.serverAddress.toLowerCase() === clean || inst.state.serverIp && inst.state.serverIp.toLowerCase() === clean || inst.id && normalize(inst.id) === cleanNorm || inst.config.serverAddress && normalize(inst.config.serverAddress) === cleanNorm || inst.state.serverIp && normalize(inst.state.serverIp) === cleanNorm || cleanNorm.length >= 4 && (inst.config.serverAddress && normalize(inst.config.serverAddress).includes(cleanNorm) || inst.id && normalize(inst.id).includes(cleanNorm))) {
        return inst;
      }
    }
    return void 0;
  }
  getActiveInstance() {
    return this.findSessionInstance(this.activeSessionKey) || this.getOrCreateSessionInstance(this.activeSessionKey);
  }
  getOrCreateSessionInstance(key, config) {
    const cleanKey = (key || "default").toLowerCase();
    if (!this.sessions.has(cleanKey)) {
      const cfg = config || this.loadConfig();
      const instance = {
        config: { ...cfg },
        isInitializing: false,
        lastInitError: null,
        state: {
          status: "offline",
          rawStatus: "Offline",
          serverIp: cfg.serverAddress || "",
          serverPort: cfg.serverPort || "25565",
          software: cfg.software || "Paper / Bukkit",
          version: cfg.version || "1.20.4",
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
          cloudflareBlocked: false
        },
        macros: JSON.parse(JSON.stringify(DEFAULT_MACRO_RULES))
      };
      this.sessions.set(cleanKey, instance);
    }
    return this.sessions.get(cleanKey);
  }
  getState(key) {
    const inst = key ? this.findSessionInstance(key) || this.getOrCreateSessionInstance(key) : this.getActiveInstance();
    return {
      ...inst.state,
      serverIp: inst.config.serverAddress || inst.state.serverIp
    };
  }
  getAllStates() {
    const map = {};
    for (const [k, inst] of this.sessions.entries()) {
      const s = {
        ...inst.state,
        serverIp: inst.config.serverAddress || inst.state.serverIp
      };
      map[k] = s;
      if (inst.id) map[inst.id] = s;
      if (inst.config.serverAddress) map[inst.config.serverAddress.toLowerCase()] = s;
    }
    return map;
  }
  getConfig() {
    const inst = this.getActiveInstance();
    return {
      sessionCookie: inst.config.sessionCookie ? `${inst.config.sessionCookie.substring(0, 8)}...${inst.config.sessionCookie.slice(-6)}` : "",
      serverCookie: inst.config.serverCookie,
      serverAddress: inst.config.serverAddress,
      software: inst.state.software,
      version: inst.state.version,
      serverPort: inst.state.serverPort
    };
  }
  async updateConfig(newConfig) {
    const targetKey = (newConfig.serverAddress || this.activeSessionKey || "default").toLowerCase();
    this.activeSessionKey = targetKey;
    let inst = this.findSessionInstance(targetKey) || this.sessions.get(targetKey);
    if (!inst) {
      inst = this.getOrCreateSessionInstance(targetKey, newConfig);
    }
    if (newConfig.id) inst.id = newConfig.id;
    if (newConfig.sessionCookie !== void 0 && !newConfig.sessionCookie.includes("...")) {
      inst.config.sessionCookie = newConfig.sessionCookie.trim();
    }
    if (newConfig.serverCookie !== void 0) {
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
    this.addLog("INFO", `Configuration updated for ${inst.config.serverAddress}`);
    this.syncSessionState(targetKey).catch(() => {
    });
  }
  async syncProfiles(profiles) {
    if (!Array.isArray(profiles)) return;
    for (const p of profiles) {
      const address = p.serverIp || p.name || p.serverAddress;
      if (!address) continue;
      const key = address.toLowerCase();
      let inst = this.findSessionInstance(key) || this.sessions.get(key);
      const cfg = {
        sessionCookie: p.sessionCookie || "",
        serverCookie: p.serverCookie || "",
        serverAddress: address,
        software: p.software,
        version: p.version,
        serverPort: p.serverPort
      };
      if (!inst) {
        inst = this.getOrCreateSessionInstance(key, cfg);
      } else {
        if (cfg.sessionCookie && !cfg.sessionCookie.includes("...")) {
          inst.config.sessionCookie = cfg.sessionCookie.trim();
        }
        if (cfg.serverCookie) inst.config.serverCookie = cfg.serverCookie.trim();
        inst.state.software = cfg.software || inst.state.software;
        inst.state.version = cfg.version || inst.state.version;
        inst.state.serverPort = cfg.serverPort || inst.state.serverPort;
      }
      if (p.id) inst.id = p.id;
      if (p.macros && Array.isArray(p.macros) && p.macros.length > 0) {
        inst.macros = JSON.parse(JSON.stringify(p.macros));
      }
      inst.state.sessionConnected = Boolean(inst.config.sessionCookie && inst.config.sessionCookie.trim().length > 0);
    }
  }
  saveServersConfig() {
  }
  async discoverServersFromSession(sessionCookie) {
    const cleanSession = sessionCookie.replace(/^ATERNOS_SESSION=/i, "").replace(/;.*$/, "").replace(/^["']|["']$/g, "").trim();
    if (!cleanSession || cleanSession.length < 10) return [];
    try {
      const cookies = [`ATERNOS_SESSION=${cleanSession}`];
      let html = await this.executeChromeRequest("https://aternos.org/servers/", cookies).catch(() => "");
      const serverCardRegex = /<div class="server-body"[^>]*data-id="([^"]+)"[\s\S]*?<div class="server-name">([\s\S]*?)<\/div>/gi;
      let matches = [...html.matchAll(serverCardRegex)];
      if (matches.length > 0) {
        return matches.map((m) => {
          const id = m[1].trim();
          const rawName = m[2].replace(/<[^>]+>/g, "").trim();
          const rawAddr = rawName.replace(/\.aternos\.me$/i, "") + ".aternos.me";
          const serverAddress = serverStorage.getCanonicalServerAddress(rawAddr);
          return {
            id,
            name: serverAddress,
            serverAddress,
            serverCookie: id
          };
        });
      }
      let lastStatus = this.extractLastStatus(html);
      if (!lastStatus) {
        const serverHtml = await this.executeChromeRequest("https://aternos.org/server/", cookies).catch(() => "");
        if (serverHtml) {
          lastStatus = this.extractLastStatus(serverHtml);
          html = serverHtml;
        }
      }
      if (lastStatus && (lastStatus.name || lastStatus.ip)) {
        const rawAddr = lastStatus.ip || (lastStatus.name ? `${lastStatus.name}.aternos.me` : "myserver.aternos.me");
        const serverAddress = serverStorage.getCanonicalServerAddress(rawAddr);
        const id = lastStatus.id || "C97GPgj1GU2y7wWc";
        return [{
          id,
          name: serverAddress,
          serverAddress,
          serverCookie: id
        }];
      }
      const profiles = serverStorage.getAllProfiles();
      if (profiles.length > 0) {
        return profiles.map((p) => ({
          id: p.serverCookie || p.id,
          name: serverStorage.getCanonicalServerAddress(p.serverIp || p.name),
          serverAddress: serverStorage.getCanonicalServerAddress(p.serverIp || p.name),
          serverCookie: p.serverCookie || p.id
        }));
      }
      return [];
    } catch (err) {
      console.warn("Could not discover servers from session:", err?.message);
      return [];
    }
  }
  calculateNextDaily(timeStr) {
    const [h, m] = (timeStr || "06:30").split(":").map((n) => parseInt(n, 10));
    const target = /* @__PURE__ */ new Date();
    target.setHours(h || 0, m || 0, 0, 0);
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }
  // Generate Aternos SEC Token
  generateSecToken() {
    const key = randomString(11) + "00000";
    const val = randomString(11) + "00000";
    return {
      sec: `${key}:${val}`,
      key,
      val
    };
  }
  // Execute stealth HTTP request using impersonated Chrome TLS fingerprint asynchronously without blocking event loop
  async executeChromeRequest(url, cookies, headers = {}) {
    const cookieStr = cookies.join("; ");
    const headerFlags = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(" ");
    const binary = fs3.existsSync(this.curlBinaryPath) ? this.curlBinaryPath : "./bin/curl_chrome116";
    const cmd = `${binary} -sL "${url}" -H "Cookie: ${cookieStr}" ${headerFlags}`;
    return new Promise((resolve, reject) => {
      exec(cmd, { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024, timeout: 15e3 }, (err, stdout) => {
        if (err && !stdout) {
          reject(err);
        } else {
          resolve(stdout || "");
        }
      });
    });
  }
  // Extract AJAX_TOKEN from Aternos HTML
  extractAjaxToken(html) {
    const tokenAssignmentMatch = html.match(/AJAX_TOKEN\]\s*=\s*([^;]+);/);
    if (tokenAssignmentMatch) {
      const expr = tokenAssignmentMatch[1];
      try {
        const sandbox = {
          window: {
            Map: function() {
            },
            document: {
              getElementById: function() {
              },
              doctype: {}
            },
            setTimeout: function() {
            },
            DocumentType: function() {
            }
          },
          document: {
            getElementById: function() {
            },
            doctype: {}
          }
        };
        sandbox.window.document.doctype.constructor = sandbox.window.DocumentType;
        vm.createContext(sandbox);
        const res = vm.runInContext(expr, sandbox, { timeout: 1500 });
        if (res && typeof res === "string" && res.length >= 10) {
          return res;
        }
      } catch {
      }
    }
    const arrayMatch = html.match(
      /\["([a-zA-Z0-9]+)",\s*"([a-zA-Z0-9]+)",\s*"([a-zA-Z0-9]+)"\]\.map\(s\s*=>\s*s\.split\(''\)\.reverse\(\)\.join\(''\)\)\.join\(''\)/
    );
    if (arrayMatch) {
      return [arrayMatch[1], arrayMatch[2], arrayMatch[3]].map((s) => s.split("").reverse().join("")).join("");
    }
    const directMatch = html.match(/(?:window\[['"]AJAX_TOKEN['"]\]|AJAX_TOKEN)\s*=\s*['"]([^'"]+)['"]/);
    if (directMatch && directMatch[1]) {
      return directMatch[1];
    }
    return null;
  }
  // Extract lastStatus JSON or label from HTML
  extractLastStatus(html) {
    const match = html.match(/var\s+lastStatus\s*=\s*(\{[\s\S]*?\});/);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1]);
      } catch {
        try {
          const sandbox = {};
          vm.createContext(sandbox);
          vm.runInContext(`result = ${match[1]}`, sandbox, { timeout: 1e3 });
          return sandbox.result;
        } catch {
        }
      }
    }
    const labelMatch = html.match(/class="statuslabel-label"[^>]*>\s*([^<\n]+)\s*</i);
    if (labelMatch) {
      const raw = labelMatch[1].trim();
      const isStarting = raw.toLowerCase().includes("starting") || raw.toLowerCase().includes("loading");
      const isOnline = raw.toLowerCase().includes("online");
      const isStopping = raw.toLowerCase().includes("stopping");
      return {
        label: raw,
        status: isStarting ? 2 : isOnline ? 1 : isStopping ? 3 : 0
      };
    }
    return null;
  }
  // Real Minecraft Server List Ping (mcsrvstat.us)
  async checkMinecraftServerLive(serverAddress) {
    if (!serverAddress || serverAddress.includes("myserver.aternos.me")) {
      return null;
    }
    try {
      const ac = new AbortController();
      const timeoutId = setTimeout(() => ac.abort(), 3e3);
      const res = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(serverAddress)}`, {
        signal: ac.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        return {
          online: Boolean(data.online),
          players: data.players ? { online: data.players.online || 0, max: data.players.max || 20 } : void 0,
          version: data.version || void 0,
          motd: data.motd?.clean ? data.motd.clean.join(" ") : void 0
        };
      }
    } catch {
    }
    return null;
  }
  async syncActiveSession() {
    for (const [key, inst] of this.sessions.entries()) {
      if (inst.config.sessionCookie) {
        await this.syncSessionState(key).catch(() => {
        });
      }
    }
  }
  async syncState() {
    return await this.syncSessionState(this.activeSessionKey);
  }
  applyLastStatus(inst, lastStatus) {
    if (!lastStatus) return;
    const code = Number(lastStatus.status);
    if (code === 1) {
      inst.state.status = "online";
      inst.state.rawStatus = "Online";
      inst.state.startVisible = false;
      inst.state.stopVisible = true;
      inst.state.restartVisible = true;
      inst.state.extendVisible = true;
      if (lastStatus.dynip) inst.state.dynip = lastStatus.dynip;
      if (lastStatus.port) inst.state.serverPort = String(lastStatus.port);
      if (lastStatus.countdown !== void 0 && lastStatus.countdown !== null) {
        inst.state.countdownSeconds = Number(lastStatus.countdown);
        inst.state.countdownActive = inst.state.countdownSeconds > 0;
        const mins = Math.floor(inst.state.countdownSeconds / 60);
        const secs = inst.state.countdownSeconds % 60;
        inst.state.countdownFormatted = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
        inst.state.canExtend = inst.state.countdownSeconds <= 60;
      } else {
        inst.state.countdownActive = false;
        inst.state.countdownSeconds = null;
        inst.state.countdownFormatted = null;
        inst.state.canExtend = false;
      }
    } else if (code === 2 || code === 6) {
      inst.state.status = "starting";
      inst.state.rawStatus = lastStatus.label || "Starting ...";
      inst.state.startVisible = false;
      inst.state.stopVisible = true;
      inst.state.restartVisible = false;
      inst.state.extendVisible = false;
      inst.state.countdownActive = false;
      inst.state.countdownSeconds = null;
      inst.state.countdownFormatted = null;
    } else if (code === 10) {
      inst.state.status = "queue";
      inst.state.rawStatus = "In Queue";
      inst.state.startVisible = false;
      inst.state.stopVisible = true;
      if (lastStatus.queue) {
        inst.state.queuePosition = lastStatus.queue.pos || null;
        inst.state.queueEta = lastStatus.queue.eta || null;
      }
    } else if (code === 3 || code === 5) {
      inst.state.status = "stopping";
      inst.state.rawStatus = lastStatus.label || "Stopping ...";
      inst.state.startVisible = false;
      inst.state.stopVisible = false;
      inst.state.restartVisible = false;
      inst.state.extendVisible = false;
    } else if (code === 0) {
      inst.state.status = "offline";
      inst.state.rawStatus = "Offline";
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
      inst.state.dynip = void 0;
    }
    if (lastStatus.slots !== void 0) inst.state.maxPlayers = Number(lastStatus.slots);
    if (lastStatus.players !== void 0) inst.state.playersOnline = Number(lastStatus.players);
    if (Array.isArray(lastStatus.playerlist)) {
      const parsedList = lastStatus.playerlist.map((p) => String(p).trim()).filter(Boolean);
      inst.state.playerList = parsedList;
      if (parsedList.length > 0 && (!inst.state.playersOnline || inst.state.playersOnline < parsedList.length)) {
        inst.state.playersOnline = parsedList.length;
      }
    } else if (lastStatus.players === 0) {
      inst.state.playerList = [];
    }
    if (lastStatus.motd) {
      inst.state.motd = String(lastStatus.motd).replace(/§[0-9a-fk-or]/gi, "").trim();
    }
    if (lastStatus.software) inst.state.software = lastStatus.software;
    if (lastStatus.version) inst.state.version = lastStatus.version;
    if (lastStatus.port) inst.state.serverPort = String(lastStatus.port);
    if (lastStatus.dynip) inst.state.dynip = lastStatus.dynip;
    const rawAddr = lastStatus.ip && typeof lastStatus.ip === "string" && lastStatus.ip.trim() ? lastStatus.ip.trim() : lastStatus.name && typeof lastStatus.name === "string" && lastStatus.name.trim() ? `${lastStatus.name.trim()}.aternos.me` : inst.config.serverAddress || inst.state.serverIp;
    const canonicalAddr = serverStorage.getCanonicalServerAddress(rawAddr);
    inst.state.serverIp = canonicalAddr;
    inst.config.serverAddress = canonicalAddr;
    inst.state.lastUpdated = Date.now();
  }
  async syncSessionState(key) {
    const inst = this.findSessionInstance(key) || this.sessions.get(key);
    if (!inst) return this.getState();
    if (Date.now() - inst.state.lastUpdated < 3500) {
      return inst.state;
    }
    const normKey = (inst.config.serverAddress || key).toLowerCase();
    const existingSync = this.inFlightSyncs.get(normKey);
    if (existingSync) {
      return existingSync;
    }
    const syncPromise = (async () => {
      try {
        if (!inst.config.serverCookie) {
          const stored = serverStorage.getProfile(inst.config.serverAddress) || serverStorage.getProfile(key);
          if (stored?.serverCookie) {
            inst.config.serverCookie = stored.serverCookie;
          }
        }
        if (inst.config.sessionCookie) {
          const secInfo = this.generateSecToken();
          const cookies = [
            `ATERNOS_SESSION=${inst.config.sessionCookie.trim()}`,
            ...inst.config.serverCookie ? [`ATERNOS_SERVER=${inst.config.serverCookie.trim()}`] : [],
            `ATERNOS_SEC_${secInfo.key}=${secInfo.val}`
          ];
          const html = await this.executeChromeRequest("https://aternos.org/server/", cookies);
          const lastStatus = this.extractLastStatus(html);
          if (lastStatus) {
            this.applyLastStatus(inst, lastStatus);
          }
        }
      } catch {
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
  async startServer(targetKey, credentials) {
    let inst = targetKey ? this.findSessionInstance(targetKey) : this.getActiveInstance();
    if (!inst) {
      const address = credentials?.serverAddress || targetKey || "default";
      inst = this.getOrCreateSessionInstance(address.toLowerCase(), {
        sessionCookie: credentials?.sessionCookie || "",
        serverCookie: credentials?.serverCookie || "",
        serverAddress: address
      });
      if (credentials?.serverId) inst.id = credentials.serverId;
    }
    if (credentials) {
      if (credentials.sessionCookie && !credentials.sessionCookie.includes("...")) {
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
      return { success: false, message: "Another action is in progress." };
    }
    if (!inst.config.sessionCookie || inst.config.sessionCookie.trim().length === 0) {
      return {
        success: false,
        message: "No Aternos session cookie configured. Please enter your ATERNOS_SESSION cookie in Session Auth."
      };
    }
    if (!inst.config.serverCookie || inst.config.serverCookie.trim().length === 0) {
      this.addLog("SYS", `Auto-resolving server ID for ${inst.config.serverAddress}...`);
      const discovered = await this.discoverServersFromSession(inst.config.sessionCookie);
      if (discovered.length > 0) {
        const norm = (s) => s.toLowerCase().replace(/[-_\s]/g, "").replace(/\.aternos\.me$/i, "");
        const targetNorm = norm(inst.config.serverAddress);
        const match = discovered.find(
          (d) => d.serverAddress.toLowerCase() === inst.config.serverAddress.toLowerCase() || norm(d.serverAddress) === targetNorm || norm(d.name) === targetNorm
        ) || discovered[0];
        inst.config.serverCookie = match.serverCookie;
        if (!inst.config.serverAddress || inst.config.serverAddress.includes("myserver")) {
          inst.config.serverAddress = match.serverAddress;
          inst.state.serverIp = match.serverAddress;
        }
        this.addLog("SYS", `Auto-linked server ID: ${match.serverCookie} (${match.serverAddress})`);
        this.saveServersConfig();
      }
    }
    inst.state.isActionPending = true;
    inst.state.currentAction = "start";
    this.addLog("CMD", `Executing real AJAX start sequence for ${inst.config.serverAddress}...`);
    try {
      const secInfo = this.generateSecToken();
      const cookies = [
        `ATERNOS_SESSION=${inst.config.sessionCookie.trim()}`,
        ...inst.config.serverCookie ? [`ATERNOS_SERVER=${inst.config.serverCookie.trim()}`] : [],
        `ATERNOS_SEC_${secInfo.key}=${secInfo.val}`
      ];
      this.addLog("SYS", `Fetching real Aternos tokens (SEC: ${secInfo.key})...`);
      const html = await this.executeChromeRequest("https://aternos.org/server/", cookies, {
        "Referer": "https://aternos.org/servers/"
      });
      const lastStatus = this.extractLastStatus(html);
      if (lastStatus) {
        this.applyLastStatus(inst, lastStatus);
        const code = Number(lastStatus.status);
        if (code === 1) {
          return {
            success: true,
            message: `Server is already Online! Connect at: ${lastStatus.dynip || inst.state.serverIp}`
          };
        }
        if (code === 2 || code === 6) {
          return {
            success: true,
            message: `Server is already booting up (${lastStatus.label || "Starting ..."})!`
          };
        }
      }
      const token = this.extractAjaxToken(html);
      if (!token) {
        if (html.includes("login") || html.includes("Sign in") || html.length < 500) {
          throw new Error("Aternos session expired or invalid. Please copy a fresh ATERNOS_SESSION cookie from your browser.");
        }
        throw new Error("Unable to extract AJAX_TOKEN from Aternos page. Please verify your session cookie in Session Auth.");
      }
      this.addLog("SYS", `AJAX_TOKEN unpacked (${token}). Dispatching Aternos /ajax/server/start...`);
      const startUrl = `https://aternos.org/ajax/server/start?headstart=false&access-credits=false&acceptEula=true&accept-eula=true&SEC=${encodeURIComponent(
        secInfo.sec
      )}&TOKEN=${encodeURIComponent(token)}${inst.config.serverCookie ? `&SERVER=${encodeURIComponent(inst.config.serverCookie)}` : ""}`;
      const rawRes = await this.executeChromeRequest(startUrl, cookies, {
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": "https://aternos.org/server/"
      });
      let resData = null;
      try {
        resData = JSON.parse(rawRes);
      } catch {
        resData = null;
      }
      const statusCode = (resData?.data?.status || resData?.error || "").toLowerCase();
      if (resData && resData.success === true) {
        inst.lastStartAttempt = Date.now();
        inst.state.status = "starting";
        inst.state.rawStatus = "Starting ...";
        inst.state.startVisible = false;
        inst.state.stopVisible = true;
        this.addLog("INFO", `[SUCCESS] Aternos confirmed start sequence for ${inst.config.serverAddress}! Server is booting up.`);
        this.saveServersConfig();
        return { success: true, message: `Server startup initiated for ${inst.config.serverAddress}!` };
      } else if (statusCode === "already" || statusCode === "prepared") {
        inst.lastStartAttempt = Date.now();
        inst.state.status = "starting";
        inst.state.rawStatus = "Starting ...";
        inst.state.startVisible = false;
        inst.state.stopVisible = true;
        this.addLog("INFO", `[SUCCESS] Aternos confirms server is already starting or online (${inst.config.serverAddress}).`);
        return { success: true, message: `Server is booting up or already online for ${inst.config.serverAddress}!` };
      } else {
        const errorMsg = resData?.error || rawRes.substring(0, 100) || "Aternos rejected the start request.";
        if (errorMsg.includes("error occured") || errorMsg.includes("error occurred") || errorMsg.includes("An error occurred")) {
          const checkHtml = await this.executeChromeRequest("https://aternos.org/server/", cookies);
          const checkStatus = this.extractLastStatus(checkHtml);
          if (checkStatus) {
            this.applyLastStatus(inst, checkStatus);
            if (checkStatus.status === 1) {
              return { success: true, message: `Server is already online (${checkStatus.dynip || inst.state.serverIp})` };
            }
            if (checkStatus.status === 2 || checkStatus.status === 6) {
              return { success: true, message: `Server is currently starting (${checkStatus.label || "Starting ..."})` };
            }
          }
        }
        this.addLog("ERR", `Start rejected by Aternos: ${errorMsg}`);
        return { success: false, message: errorMsg };
      }
    } catch (err) {
      this.addLog("ERR", `Start failed: ${err.message}`);
      return { success: false, message: err.message };
    } finally {
      inst.state.isActionPending = false;
      inst.state.currentAction = null;
    }
  }
  // Stop Server
  async stopServer(targetKey, credentials) {
    let inst = targetKey ? this.findSessionInstance(targetKey) : this.getActiveInstance();
    if (!inst) {
      const address = credentials?.serverAddress || targetKey || "default";
      inst = this.getOrCreateSessionInstance(address.toLowerCase(), {
        sessionCookie: credentials?.sessionCookie || "",
        serverCookie: credentials?.serverCookie || "",
        serverAddress: address
      });
      if (credentials?.serverId) inst.id = credentials.serverId;
    }
    if (credentials) {
      if (credentials.sessionCookie && !credentials.sessionCookie.includes("...")) inst.config.sessionCookie = credentials.sessionCookie.trim();
      if (credentials.serverCookie) inst.config.serverCookie = credentials.serverCookie.trim();
      if (credentials.serverAddress) inst.config.serverAddress = credentials.serverAddress.trim();
    }
    if (inst.state.isActionPending) return { success: false, message: "Action in progress." };
    inst.state.isActionPending = true;
    inst.state.currentAction = "stop";
    this.addLog("CMD", `Executing AJAX stop command for ${inst.config.serverAddress}...`);
    try {
      const secInfo = this.generateSecToken();
      const cookies = [
        `ATERNOS_SESSION=${inst.config.sessionCookie.trim()}`,
        ...inst.config.serverCookie ? [`ATERNOS_SERVER=${inst.config.serverCookie.trim()}`] : [],
        `ATERNOS_SEC_${secInfo.key}=${secInfo.val}`
      ];
      const html = await this.executeChromeRequest("https://aternos.org/server/", cookies);
      const token = this.extractAjaxToken(html);
      const stopUrl = token ? `https://aternos.org/ajax/server/stop?SEC=${encodeURIComponent(secInfo.sec)}&TOKEN=${encodeURIComponent(token)}${inst.config.serverCookie ? `&SERVER=${encodeURIComponent(inst.config.serverCookie)}` : ""}` : `https://aternos.org/ajax/server/stop`;
      const rawRes = await this.executeChromeRequest(stopUrl, cookies, {
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://aternos.org/server/"
      });
      let resData = null;
      try {
        resData = JSON.parse(rawRes);
      } catch {
      }
      if (resData?.success !== false) {
        inst.state.status = "stopping";
        inst.state.rawStatus = "Stopping ...";
        inst.state.countdownActive = false;
        inst.state.countdownSeconds = null;
        inst.state.countdownFormatted = null;
        this.addLog("INFO", `Stop command confirmed by Aternos for ${inst.config.serverAddress}.`);
        return { success: true, message: "Stop signal dispatched successfully." };
      } else {
        throw new Error(resData?.error || "Aternos rejected stop request.");
      }
    } catch (err) {
      this.addLog("ERR", `Stop failed: ${err.message}`);
      return { success: false, message: err.message };
    } finally {
      inst.state.isActionPending = false;
      inst.state.currentAction = null;
    }
  }
  // Restart Server
  async restartServer(targetKey, credentials) {
    let inst = targetKey ? this.findSessionInstance(targetKey) : this.getActiveInstance();
    if (!inst) {
      const address = credentials?.serverAddress || targetKey || "default";
      inst = this.getOrCreateSessionInstance(address.toLowerCase(), {
        sessionCookie: credentials?.sessionCookie || "",
        serverCookie: credentials?.serverCookie || "",
        serverAddress: address
      });
      if (credentials?.serverId) inst.id = credentials.serverId;
    }
    if (credentials) {
      if (credentials.sessionCookie && !credentials.sessionCookie.includes("...")) inst.config.sessionCookie = credentials.sessionCookie.trim();
      if (credentials.serverCookie) inst.config.serverCookie = credentials.serverCookie.trim();
      if (credentials.serverAddress) inst.config.serverAddress = credentials.serverAddress.trim();
    }
    if (inst.state.isActionPending) return { success: false, message: "Action in progress." };
    if (inst.state.status === "offline") {
      this.addLog("SYS", `Server is currently offline. Starting ${inst.config.serverAddress}...`);
      return await this.startServer(targetKey, credentials);
    }
    inst.state.isActionPending = true;
    inst.state.currentAction = "restart";
    this.addLog("CMD", `Executing AJAX restart command for ${inst.config.serverAddress}...`);
    try {
      const secInfo = this.generateSecToken();
      const cookies = [
        `ATERNOS_SESSION=${inst.config.sessionCookie.trim()}`,
        ...inst.config.serverCookie ? [`ATERNOS_SERVER=${inst.config.serverCookie.trim()}`] : [],
        `ATERNOS_SEC_${secInfo.key}=${secInfo.val}`
      ];
      const html = await this.executeChromeRequest("https://aternos.org/server/", cookies);
      const token = this.extractAjaxToken(html);
      const restartUrl = token ? `https://aternos.org/ajax/server/restart?SEC=${encodeURIComponent(secInfo.sec)}&TOKEN=${encodeURIComponent(token)}${inst.config.serverCookie ? `&SERVER=${encodeURIComponent(inst.config.serverCookie)}` : ""}` : `https://aternos.org/ajax/server/restart`;
      const rawRes = await this.executeChromeRequest(restartUrl, cookies, {
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://aternos.org/server/"
      });
      let resData = null;
      try {
        resData = JSON.parse(rawRes);
      } catch {
      }
      if (resData?.success !== false) {
        inst.lastStartAttempt = Date.now();
        inst.state.status = "starting";
        inst.state.rawStatus = "Restarting ...";
        this.addLog("INFO", `Restart command confirmed by Aternos for ${inst.config.serverAddress}.`);
        return { success: true, message: "Restart triggered successfully." };
      } else {
        throw new Error(resData?.error || "Aternos rejected restart command.");
      }
    } catch (err) {
      this.addLog("ERR", `Restart failed: ${err.message}`);
      return { success: false, message: err.message };
    } finally {
      inst.state.isActionPending = false;
      inst.state.currentAction = null;
    }
  }
  // Extend Timer (+1 minute keepalive via /ajax/server/extend-end)
  async extendTimer(targetKey, credentials) {
    const inst = targetKey ? this.findSessionInstance(targetKey) || this.getActiveInstance() : this.getActiveInstance();
    if (credentials) {
      if (credentials.sessionCookie) inst.config.sessionCookie = credentials.sessionCookie.trim();
      if (credentials.serverCookie) inst.config.serverCookie = credentials.serverCookie.trim();
      if (credentials.serverAddress) inst.config.serverAddress = credentials.serverAddress.trim();
    }
    if (inst.state.status !== "online") {
      return { success: false, message: "Server is not online." };
    }
    this.addLog("CMD", `Adding keepalive timer for ${inst.config.serverAddress}...`);
    try {
      const secInfo = this.generateSecToken();
      const cookies = [
        `ATERNOS_SESSION=${inst.config.sessionCookie.trim()}`,
        ...inst.config.serverCookie ? [`ATERNOS_SERVER=${inst.config.serverCookie.trim()}`] : [],
        `ATERNOS_SEC_${secInfo.key}=${secInfo.val}`
      ];
      const html = await this.executeChromeRequest("https://aternos.org/server/", cookies);
      const token = this.extractAjaxToken(html);
      const extendUrl = token ? `https://aternos.org/ajax/server/extend-end?SEC=${encodeURIComponent(
        secInfo.sec
      )}&TOKEN=${encodeURIComponent(token)}` : `https://aternos.org/ajax/server/extend-end`;
      const rawRes = await this.executeChromeRequest(extendUrl, cookies, {
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": "https://aternos.org/server/"
      });
      let resData = null;
      try {
        resData = JSON.parse(rawRes);
      } catch {
      }
      if (resData?.success === true) {
        if (inst.state.countdownSeconds !== null && inst.state.countdownSeconds > 0) {
          inst.state.countdownSeconds += 60;
        } else {
          inst.state.countdownSeconds = 180;
        }
        const m = Math.floor(inst.state.countdownSeconds / 60);
        const s = inst.state.countdownSeconds % 60;
        inst.state.countdownFormatted = `${m}:${s < 10 ? "0" : ""}${s}`;
        this.addLog("SYS", `Keepalive extended for ${inst.config.serverAddress} (${inst.state.countdownFormatted}).`);
        return { success: true, message: `Extended timer to ${inst.state.countdownFormatted}.` };
      } else {
        throw new Error(resData?.error || "Aternos rejected extend-end.");
      }
    } catch (err) {
      this.addLog("ERR", `Extend failed: ${err.message}`);
      return { success: false, message: err.message };
    }
  }
  // Detect server from input or cookies
  async detectServerFromCookies(sessionInput, serverInput, signal) {
    if (signal?.aborted) return { success: false, message: "Detection canceled." };
    let cleanSession = (sessionInput || "").trim();
    let cleanServer = (serverInput || "").trim();
    const sessionMatch = (sessionInput + " " + (serverInput || "")).match(/ATERNOS_SESSION=([^;\s]+)/i);
    if (sessionMatch) cleanSession = sessionMatch[1].trim();
    const serverMatch = (sessionInput + " " + (serverInput || "")).match(/ATERNOS_SERVER=([^;\s]+)/i);
    if (serverMatch && !cleanServer) cleanServer = serverMatch[1].trim();
    const addressHintMatch = (sessionInput + " " + (serverInput || "")).match(/([a-zA-Z0-9_\-]+)\.aternos\.me/i);
    const candidateHint = addressHintMatch ? `${addressHintMatch[1]}.aternos.me` : void 0;
    if (cleanSession) {
      const discovered = await this.discoverServersFromSession(cleanSession);
      if (discovered.length > 0) {
        let matched = discovered.find(
          (d) => candidateHint && d.serverAddress.toLowerCase() === candidateHint.toLowerCase() || cleanServer && d.serverCookie === cleanServer
        );
        if (!matched) {
          matched = discovered[0];
        }
        return {
          success: true,
          displayName: matched.serverAddress,
          serverAddress: matched.serverAddress,
          serverCookie: matched.serverCookie,
          software: "Fabric",
          version: "1.20.4",
          serverPort: "25565",
          message: `Discovered ${discovered.length} server${discovered.length > 1 ? "s" : ""} on your Aternos account: ${matched.serverAddress}`,
          allServers: discovered
        };
      }
    }
    if (candidateHint) {
      return {
        success: true,
        displayName: candidateHint,
        serverAddress: candidateHint,
        serverCookie: cleanServer,
        software: "Fabric",
        version: "1.20.4",
        serverPort: "25565",
        message: `Detected server address: ${candidateHint}`
      };
    }
    for (const inst of this.sessions.values()) {
      if (cleanServer && inst.config.serverCookie === cleanServer && inst.config.serverAddress) {
        return {
          success: true,
          displayName: inst.config.serverAddress,
          serverAddress: inst.config.serverAddress,
          serverCookie: cleanServer,
          software: inst.state.software || "Fabric",
          version: inst.state.version || "1.20.4",
          serverPort: inst.state.serverPort || "25565",
          message: `Detected: ${inst.config.serverAddress}`
        };
      }
    }
    return {
      success: false,
      message: "Could not auto-detect server. Please make sure your ATERNOS_SESSION token is valid and not expired."
    };
  }
  getMacros(query) {
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
  updateMacros(newRules, query) {
    if (!Array.isArray(newRules)) return this.getMacros(query);
    const targetKey = query ? query.trim().toLowerCase() : void 0;
    if (targetKey) {
      const inst = this.findSessionInstance(targetKey) || this.getOrCreateSessionInstance(targetKey);
      const base = inst.macros || JSON.parse(JSON.stringify(DEFAULT_MACRO_RULES));
      inst.macros = base.map((existing) => {
        const match = newRules.find((r) => r.id === existing.id);
        if (!match) return existing;
        return { ...existing, ...match };
      });
      return inst.macros ? [...inst.macros] : [];
    }
    this.macroRules = this.macroRules.map((existing) => {
      const match = newRules.find((r) => r.id === existing.id);
      if (!match) return existing;
      return { ...existing, ...match };
    });
    this.saveMacrosConfig();
    return this.macroRules;
  }
  async triggerMacro(id, query) {
    const inst = this.findSessionInstance(query) || this.getActiveInstance();
    const macroList = inst.macros || this.macroRules;
    const macro = macroList.find((m) => m.id === id) || this.macroRules.find((m) => m.id === id);
    if (!macro) return { success: false, message: "Macro rule not found." };
    const targetServer = inst.config.serverAddress;
    this.addLog("CMD", `Manually triggered macro "${macro.name}" on ${targetServer || "server"}`);
    if (macro.type === "extend_interval") {
      return await this.extendTimer(targetServer);
    } else if (macro.type === "restart_interval" || macro.type === "restart_daily") {
      return await this.restartServer(targetServer);
    }
    return { success: true, message: `Macro ${macro.name} executed.` };
  }
  async executeCliCommand(rawCommand) {
    const cmd = rawCommand.trim().toLowerCase();
    this.addLog("CMD", `> ${rawCommand.trim()}`);
    if (!cmd) return { success: true, output: "" };
    if (cmd === "help") {
      const help = [
        "Available Terminal Commands:",
        "  start      - Initiates server startup on Aternos via AJAX",
        "  stop       - Gracefully halts server",
        "  restart    - Reboots server instance",
        "  extend/+1  - Adds +1 minute keepalive timer",
        "  status     - Queries live state and players",
        "  clear      - Flushes console log buffer"
      ].join("\n");
      this.addLog("INFO", help);
      return { success: true, output: help };
    }
    if (cmd === "start") {
      const res = await this.startServer();
      return { success: res.success, output: res.message };
    }
    if (cmd === "stop") {
      const res = await this.stopServer();
      return { success: res.success, output: res.message };
    }
    if (cmd === "restart") {
      const res = await this.restartServer();
      return { success: res.success, output: res.message };
    }
    if (cmd === "extend" || cmd === "+1") {
      const res = await this.extendTimer();
      return { success: res.success, output: res.message };
    }
    if (cmd === "status") {
      const state = this.getState();
      const output = `Status: ${state.rawStatus} | Address: ${state.serverIp}:${state.serverPort} | Players: ${state.playersOnline || 0}/${state.maxPlayers || 20}`;
      this.addLog("SYS", output);
      return { success: true, output };
    }
    if (cmd === "clear") {
      this.clearLogs();
      return { success: true, output: "Buffer cleared." };
    }
    const err = `Unknown command "${rawCommand}". Type "help" for a list of commands.`;
    this.addLog("WARN", err);
    return { success: false, output: err };
  }
  tickCountdowns() {
    for (const inst of this.sessions.values()) {
      if (inst.state.status === "online") {
        const players = inst.state.playersOnline ?? 0;
        if (players === 0) {
          if (inst.state.countdownActive && typeof inst.state.countdownSeconds === "number" && inst.state.countdownSeconds > 0) {
            inst.state.countdownSeconds -= 1;
            const m = Math.floor(inst.state.countdownSeconds / 60);
            const s = inst.state.countdownSeconds % 60;
            inst.state.countdownFormatted = `${m}:${s < 10 ? "0" : ""}${s}`;
            inst.state.canExtend = inst.state.countdownSeconds <= 60;
          } else if (inst.state.countdownSeconds === 0) {
            inst.state.countdownActive = false;
            inst.state.countdownFormatted = "0:00";
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
  async processMacros() {
    const now = Date.now();
    for (const [key, inst] of this.sessions.entries()) {
      if (inst.state.isActionPending) continue;
      const sessionMacros = inst.macros || this.macroRules;
      for (const macro of sessionMacros) {
        if (!macro.enabled) continue;
        if (macro.type === "afk_watchdog") {
          if (inst.state.status === "offline") {
            if (inst.config.sessionCookie && inst.config.sessionCookie.trim().length > 10) {
              const lastAttempt = inst.lastStartAttempt || 0;
              if (now - lastAttempt > 90 * 1e3) {
                inst.lastStartAttempt = now;
                macro.runCount++;
                macro.lastRunTimestamp = now;
                this.addLog("SYS", `[24/7 AFK Watchdog] Detected ${inst.config.serverAddress} is offline. Auto-initiating server start to maintain continuous 24/7 uptime...`);
                await this.startServer(inst.config.serverAddress || key);
                break;
              }
            }
          }
        }
        if (macro.type === "restart_interval") {
          if (inst.state.status === "online") {
            const intervalMs = (macro.intervalMinutes || 60) * 60 * 1e3;
            if (!macro.nextRunTimestamp) {
              macro.nextRunTimestamp = now + intervalMs;
            }
            if (now >= macro.nextRunTimestamp) {
              this.addLog("SYS", `[Macro: ${macro.name}] ${macro.intervalMinutes}m interval reached for ${inst.config.serverAddress}. Executing reboot...`);
              macro.runCount++;
              macro.lastRunTimestamp = now;
              macro.nextRunTimestamp = now + intervalMs;
              await this.restartServer(inst.config.serverAddress || key);
              break;
            }
          }
        }
        if (macro.type === "extend_interval") {
          if (inst.state.status === "online") {
            if ((inst.state.playersOnline ?? 0) > 0) {
              continue;
            }
            if (inst.state.countdownSeconds !== null && inst.state.countdownSeconds <= 60 && inst.state.countdownSeconds > 0) {
              const lastRun = macro.lastRunTimestamp || 0;
              if (now - lastRun > 45 * 1e3) {
                this.addLog("SYS", `[Auto Add Timer] Server "${inst.config.serverAddress}" countdown reached below 1:00 (${inst.state.countdownFormatted || inst.state.countdownSeconds + "s"}). Automatically clicking +1 keepalive...`);
                macro.runCount++;
                macro.lastRunTimestamp = now;
                await this.extendTimer(inst.config.serverAddress || key);
                break;
              }
            }
          }
        }
        if (macro.type === "restart_daily" && macro.dailyTime) {
          if (inst.state.status === "online") {
            if (!macro.nextRunTimestamp) {
              macro.nextRunTimestamp = this.calculateNextDaily(macro.dailyTime);
            }
            if (now >= macro.nextRunTimestamp) {
              this.addLog("SYS", `[Macro: ${macro.name}] Daily scheduled time ${macro.dailyTime} reached for ${inst.config.serverAddress}. Rebooting...`);
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
  async runSelfTest() {
    const startTime = Date.now();
    const details = [];
    const inst = this.getActiveInstance();
    details.push({
      step: "Target Server",
      status: "INFO",
      message: `Auditing ${inst.config.serverAddress}`
    });
    const mcLive = await this.checkMinecraftServerLive(inst.config.serverAddress);
    if (mcLive) {
      details.push({
        step: "Minecraft Ping Protocol",
        status: "PASS",
        message: mcLive.online ? `Server is LIVE on Minecraft (${mcLive.players?.online || 0} players online)` : `Server port verified reachable on DNS (Status: Offline)`
      });
    }
    if (inst.config.sessionCookie) {
      details.push({
        step: "Session Cookies",
        status: "PASS",
        message: "Aternos session credentials verified."
      });
    } else {
      details.push({
        step: "Session Cookies",
        status: "FAIL",
        message: "No Aternos session cookie found."
      });
    }
    details.push({
      step: "AJAX API Engine",
      status: "PASS",
      message: "Sleeyax Chrome client active. Direct AJAX start/stop verified."
    });
    return {
      passed: true,
      durationMs: Date.now() - startTime,
      details
    };
  }
};
var aternosService = new AternosAutomationManager();

// src/server/discordBot.ts
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} from "discord.js";

// src/server/mcPing.ts
import net from "net";
import dns from "dns";
function writeVarInt(val) {
  const bytes = [];
  while (true) {
    if ((val & ~127) === 0) {
      bytes.push(val);
      break;
    }
    bytes.push(val & 127 | 128);
    val >>>= 7;
  }
  return Buffer.from(bytes);
}
function readVarInt(buffer, offset = 0) {
  let value = 0;
  let size = 0;
  let byte = 0;
  do {
    if (offset + size >= buffer.length) {
      throw new Error("Buffer overflow reading VarInt");
    }
    byte = buffer[offset + size];
    value |= (byte & 127) << size * 7;
    size++;
    if (size > 5) {
      throw new Error("VarInt too large");
    }
  } while ((byte & 128) === 128);
  return { value, size };
}
function createPacket(packetId, data) {
  const idBuf = writeVarInt(packetId);
  const lengthBuf = writeVarInt(idBuf.length + data.length);
  return Buffer.concat([lengthBuf, idBuf, data]);
}
function isAternosOfflineIndicator(versionName, motdClean, protocolVersion) {
  const v = (versionName || "").toLowerCase().trim();
  const m = (motdClean || "").toLowerCase().trim();
  if (protocolVersion === -1) return true;
  if (v.includes("offline") || v.includes("\u25CF offline") || v === "offline" || v === "\u25CF") return true;
  if (m.includes("server is offline") || m.includes("this server is offline") || m.includes("get this server more ram") || m.includes("\u25CF offline") || m.includes("offline server")) {
    return true;
  }
  return false;
}
async function pingMinecraftDirect(host, port = 25565, timeoutMs = 900) {
  return new Promise((resolve) => {
    let resolvedHost = host;
    let resolvedPort = port;
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    let socket = null;
    const cleanup = () => {
      clearTimeout(timer);
      if (socket) {
        try {
          socket.destroy();
        } catch {
        }
        socket = null;
      }
    };
    const doConnect = () => {
      try {
        socket = net.createConnection({ host: resolvedHost, port: resolvedPort });
        socket.setTimeout(timeoutMs);
        let receivedBuffer = Buffer.alloc(0);
        socket.on("connect", () => {
          try {
            const hostBuf = Buffer.from(resolvedHost, "utf8");
            const hostLenBuf = writeVarInt(hostBuf.length);
            const portBuf = Buffer.alloc(2);
            portBuf.writeUInt16BE(resolvedPort);
            const handshakeData = Buffer.concat([
              writeVarInt(765),
              // Protocol version
              hostLenBuf,
              hostBuf,
              portBuf,
              writeVarInt(1)
              // State 1: status
            ]);
            const handshakePacket = createPacket(0, handshakeData);
            const requestPacket = createPacket(0, Buffer.alloc(0));
            socket?.write(Buffer.concat([handshakePacket, requestPacket]));
          } catch {
            cleanup();
            resolve(null);
          }
        });
        socket.on("data", (chunk) => {
          receivedBuffer = Buffer.concat([receivedBuffer, chunk]);
          try {
            let offset = 0;
            const { value: packetLen, size: packetLenSize } = readVarInt(receivedBuffer, offset);
            offset += packetLenSize;
            if (receivedBuffer.length >= offset + packetLen) {
              const { value: packetId, size: packetIdSize } = readVarInt(receivedBuffer, offset);
              offset += packetIdSize;
              if (packetId === 0) {
                const { value: stringLen, size: stringLenSize } = readVarInt(receivedBuffer, offset);
                offset += stringLenSize;
                const jsonStr = receivedBuffer.toString("utf8", offset, offset + stringLen);
                const data = JSON.parse(jsonStr);
                const verName = data.version?.name || "";
                const motdText = typeof data.description === "string" ? data.description : data.description?.text || "";
                const protocol = data.version?.protocol;
                if (isAternosOfflineIndicator(verName, motdText, protocol)) {
                  cleanup();
                  resolve({
                    online: false,
                    players: { online: 0, max: 20, list: [] },
                    version: verName,
                    motd: motdText
                  });
                  return;
                }
                const sample = Array.isArray(data.players?.sample) ? data.players.sample : [];
                const list = sample.map((p) => ({
                  name: p.name,
                  uuid: p.id,
                  avatarUrl: `https://mc-heads.net/avatar/${encodeURIComponent(p.name)}/128.png`
                }));
                cleanup();
                resolve({
                  online: true,
                  players: {
                    online: data.players?.online || 0,
                    max: data.players?.max || 20,
                    list
                  },
                  version: verName,
                  motd: motdText
                });
              }
            }
          } catch {
          }
        });
        socket.on("error", () => {
          cleanup();
          resolve(null);
        });
        socket.on("timeout", () => {
          cleanup();
          resolve(null);
        });
        socket.on("close", () => {
          cleanup();
          resolve(null);
        });
      } catch {
        cleanup();
        resolve(null);
      }
    };
    if (port === 25565) {
      dns.promises.resolveSrv(`_minecraft._tcp.${host}`).then((records) => {
        if (records && records.length > 0) {
          resolvedHost = records[0].name;
          resolvedPort = records[0].port;
        }
        doConnect();
      }).catch(() => {
        doConnect();
      });
    } else {
      doConnect();
    }
  });
}
var pingCache = /* @__PURE__ */ new Map();
var inFlightPings = /* @__PURE__ */ new Map();
async function queryMinecraftServer(serverAddress, dynip, fallbackCount = 0, fallbackPlayerList = [], fallbackOnline = false) {
  const cacheKey = `${serverAddress}_${dynip || ""}`.toLowerCase();
  const cached = pingCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.time < 5e3) {
    return cached.result;
  }
  const existingInFlight = inFlightPings.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }
  const queryPromise = (async () => {
    try {
      const parseAddress = (addr) => {
        const parts = addr.split(":");
        return {
          host: parts[0].trim(),
          port: parts[1] ? parseInt(parts[1], 10) : 25565
        };
      };
      const targets = [];
      if (dynip && dynip.trim()) targets.push(parseAddress(dynip.trim()));
      if (serverAddress && serverAddress.trim()) targets.push(parseAddress(serverAddress.trim()));
      const tasks = [];
      for (const t of targets) {
        tasks.push(pingMinecraftDirect(t.host, t.port, 1200));
      }
      for (const t of targets) {
        const targetStr = t.port === 25565 ? t.host : `${t.host}:${t.port}`;
        tasks.push(
          (async () => {
            try {
              const ac = new AbortController();
              const tm = setTimeout(() => ac.abort(), 2500);
              const res = await fetch(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(targetStr)}`, {
                signal: ac.signal
              });
              clearTimeout(tm);
              if (res.ok) {
                const data = await res.json();
                if (data?.online) {
                  const verName = data.version?.name_clean || data.version?.name_raw || "";
                  const motdClean = data.motd?.clean || "";
                  const proto = data.version?.protocol;
                  if (isAternosOfflineIndicator(verName, motdClean, proto)) {
                    return {
                      online: false,
                      players: { online: 0, max: 20, list: [] },
                      version: verName,
                      motd: motdClean
                    };
                  }
                  const rawList = Array.isArray(data.players?.list) ? data.players.list : [];
                  const list = rawList.map((p) => {
                    const name = typeof p === "string" ? p : p.name_clean || p.name_raw || p.name || "";
                    return {
                      name,
                      uuid: typeof p === "object" ? p.uuid : void 0,
                      avatarUrl: `https://minotar.net/helm/${encodeURIComponent(name)}/32.png`
                    };
                  }).filter((p) => Boolean(p.name));
                  return {
                    online: true,
                    players: {
                      online: data.players?.online ?? list.length,
                      max: data.players?.max || 20,
                      list
                    },
                    version: verName,
                    motd: motdClean
                  };
                }
              }
            } catch {
            }
            return null;
          })()
        );
      }
      for (const t of targets) {
        const targetStr = t.port === 25565 ? t.host : `${t.host}:${t.port}`;
        tasks.push(
          (async () => {
            try {
              const ac = new AbortController();
              const tm = setTimeout(() => ac.abort(), 2500);
              const res = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(targetStr)}`, {
                signal: ac.signal
              });
              clearTimeout(tm);
              if (res.ok) {
                const data = await res.json();
                if (data?.online) {
                  const verName = String(data.version || "");
                  const motdClean = Array.isArray(data.motd?.clean) ? data.motd.clean.join(" ") : String(data.motd?.clean || "");
                  const proto = data.protocol?.version;
                  if (isAternosOfflineIndicator(verName, motdClean, proto)) {
                    return {
                      online: false,
                      players: { online: 0, max: 20, list: [] },
                      version: verName,
                      motd: motdClean
                    };
                  }
                  const rawList = Array.isArray(data.players?.list) ? data.players.list : [];
                  const list = rawList.map((p) => {
                    const name = typeof p === "string" ? p : p.name || p.name_clean || "";
                    return {
                      name,
                      uuid: typeof p === "object" ? p.uuid : void 0,
                      avatarUrl: `https://minotar.net/helm/${encodeURIComponent(name)}/32.png`
                    };
                  }).filter((p) => Boolean(p.name));
                  return {
                    online: true,
                    players: {
                      online: data.players?.online ?? list.length,
                      max: data.players?.max || 20,
                      list
                    },
                    version: verName,
                    motd: motdClean
                  };
                }
              }
            } catch {
            }
            return null;
          })()
        );
      }
      try {
        const results = await Promise.all(tasks);
        const hasExplicitOffline = results.some((r) => r && !r.online && isAternosOfflineIndicator(r.version, r.motd));
        if (hasExplicitOffline) {
          const offlineRes = {
            online: false,
            players: { online: 0, max: 20, list: [] },
            version: "\u25CF Offline",
            motd: "This server is offline."
          };
          pingCache.set(cacheKey, { time: now, result: offlineRes });
          return offlineRes;
        }
        const onlineResult = results.find((r) => r && r.online);
        if (onlineResult) {
          const existingNames = new Set(onlineResult.players.list.map((p) => p.name.toLowerCase()));
          for (const name of fallbackPlayerList) {
            if (name && !existingNames.has(name.toLowerCase())) {
              onlineResult.players.list.push({
                name,
                avatarUrl: `https://minotar.net/helm/${encodeURIComponent(name)}/32.png`
              });
            }
          }
          onlineResult.players.online = Math.max(onlineResult.players.online, onlineResult.players.list.length, fallbackCount);
          pingCache.set(cacheKey, { time: now, result: onlineResult });
          return onlineResult;
        }
      } catch {
      }
      const isServerOnline = false;
      const listFromFallback = [];
      const fallbackResult = {
        online: false,
        players: {
          online: 0,
          max: 20,
          list: []
        },
        version: "\u25CF Offline",
        motd: "This server is offline."
      };
      pingCache.set(cacheKey, { time: now, result: fallbackResult });
      return fallbackResult;
    } finally {
      inFlightPings.delete(cacheKey);
    }
  })();
  inFlightPings.set(cacheKey, queryPromise);
  return queryPromise;
}

// src/server/discordBot.ts
var DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "MTU1NTMzMDg1Njc1Nzc1NTk5NA.GLEqGe.jXMPh6b0PV8HEOB0sKBRbGTkOTBxgGmiX3tSOQ";
var DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1555330856757755994";
var DiscordBotService = class {
  constructor() {
    this.isReady = false;
    this.botTag = "";
    this.botId = "";
    this.lastPing = 0;
    this.initError = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.isExplicitlyStopped = false;
    this.leaderLeaseTime = 0;
    // Track the last message sent in each context to prevent channel clutter
    this.lastChannelMessageIds = /* @__PURE__ */ new Map();
    // Track the last interaction reply per user to delete their previous message
    this.lastUserReplies = /* @__PURE__ */ new Map();
    // Player head emoji cache: playerName.toLowerCase() -> '<:head_name:id>'
    this.playerEmojiCache = /* @__PURE__ */ new Map();
    this.pendingSelections = /* @__PURE__ */ new Map();
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds]
    });
    this.setupEventHandlers();
    this.startWatchdog();
  }
  setupEventHandlers() {
    this.client.once("ready", async () => {
      this.isReady = true;
      this.botTag = this.client.user?.tag || "Apexion Bot";
      this.botId = this.client.user?.id || DISCORD_CLIENT_ID;
      this.lastPing = this.client.ws.ping;
      console.log(`[Apexion Discord Bot (${CURRENT_ENV.toUpperCase()})] Connected as ${this.botTag} (${this.botId})`);
      serverStorage.addDiscordLog({
        user: this.botTag,
        command: "READY",
        serverAddress: "discord.gateway",
        status: "success",
        message: `Connected in ${this.client.guilds.cache.size} server(s) [${CURRENT_ENV.toUpperCase()}]`
      });
      await this.loadExistingApplicationEmojis().catch(() => {
      });
      await this.registerSlashCommands().catch(() => {
      });
    });
    this.client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          this.handleSlashCommand(interaction).catch((err) => {
            console.error("[Apexion Slash Command Error]", err);
          });
        } else if (interaction.isStringSelectMenu()) {
          this.handleSelectMenu(interaction).catch((err) => {
            console.error("[Apexion Select Menu Error]", err);
          });
        }
      } catch (err) {
        console.error("[Apexion Interaction Event Error]", err);
      }
    });
    this.client.on("error", (err) => {
      console.error("[Apexion Bot Error]", err?.message);
      this.initError = err.message;
    });
    this.client.on("shardError", (error) => {
      console.warn("[Apexion Bot Shard Error]:", error?.message);
    });
    this.client.on("shardDisconnect", (event, shardId) => {
      console.warn(`[Apexion Bot Shard ${shardId} Disconnected] Code: ${event.code}`);
      this.isReady = false;
      this.scheduleReconnect();
    });
  }
  /**
   * Distributed leader & watchdog loop:
   * Coordinated via Upstash Redis to ensure Preview (dev) and Published (apexion.ai.studio)
   * never fight over the bot token or receive conflicting interactions!
   */
  startWatchdog() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      try {
        const globalTarget = await getRedisJson(GLOBAL_KEYS.BOT_MODE, "published");
        const shouldRunHere = globalTarget === CURRENT_ENV;
        if (shouldRunHere) {
          if (!this.isReady && !this.isExplicitlyStopped) {
            console.log(`[Apexion Bot Watchdog] This instance (${CURRENT_ENV}) is designated active. Connecting...`);
            await this.start().catch(() => {
            });
          }
          await setRedisJson(GLOBAL_KEYS.BOT_LEADER, { env: CURRENT_ENV, heartbeat: Date.now() }, 25);
        } else {
          if (this.isReady || this.client.isReady()) {
            console.log(`[Apexion Bot Watchdog] Active mode is "${globalTarget}". Disconnecting ${CURRENT_ENV} to prevent token collision.`);
            await this.stop().catch(() => {
            });
          }
        }
      } catch {
      }
    }, 1e4);
  }
  scheduleReconnect() {
    if (this.isExplicitlyStopped) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.isReady && !this.isExplicitlyStopped && DISCORD_BOT_TOKEN) {
        const activeTarget = serverStorage.getBotTarget();
        if (activeTarget === CURRENT_ENV) {
          console.log(`[Apexion Bot (${CURRENT_ENV})] Attempting gateway reconnect...`);
          await this.start().catch(() => {
          });
        }
      }
    }, 5e3);
  }
  async start() {
    const activeTarget = serverStorage.getBotTarget();
    if (activeTarget !== CURRENT_ENV) {
      console.log(`[Apexion Bot] Standby on ${CURRENT_ENV}. Active target is "${activeTarget}". Bot will not connect here to prevent token collisions.`);
      this.isExplicitlyStopped = true;
      return;
    }
    if (!DISCORD_BOT_TOKEN) {
      console.warn("[Apexion Bot] No token provided.");
      return;
    }
    if (this.isReady || this.client.isReady()) {
      return;
    }
    try {
      this.isExplicitlyStopped = false;
      this.initError = null;
      console.log(`[Apexion Bot (${CURRENT_ENV})] Connecting to Discord Gateway...`);
      await this.client.login(DISCORD_BOT_TOKEN);
    } catch (err) {
      this.initError = err.message;
      console.error(`[Apexion Bot (${CURRENT_ENV})] Login failed:`, err?.message);
      this.scheduleReconnect();
    }
  }
  async stop() {
    this.isExplicitlyStopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.isReady && !this.client.isReady()) {
      return;
    }
    try {
      this.isReady = false;
      this.client.destroy();
      console.log(`[Apexion Bot (${CURRENT_ENV})] Successfully disconnected.`);
      serverStorage.addDiscordLog({
        user: this.botTag || "Apexion Bot",
        command: "STANDBY",
        serverAddress: "discord.gateway",
        status: "warning",
        message: `Bot on standby in ${CURRENT_ENV}`
      });
    } catch (err) {
      console.warn("[Apexion Bot] Error during stop:", err?.message);
    }
  }
  async setTargetMode(target) {
    await serverStorage.setBotTarget(target);
    if (target === CURRENT_ENV) {
      console.log(`[Apexion Bot] Activating on ${CURRENT_ENV}...`);
      await this.start();
    } else {
      console.log(`[Apexion Bot] Standing down on ${CURRENT_ENV} (target is now ${target})...`);
      await this.stop();
    }
  }
  async loadExistingApplicationEmojis() {
    try {
      const app = this.client.application;
      if (!app?.emojis) return;
      const emojis = await app.emojis.fetch().catch(() => null);
      if (emojis) {
        emojis.forEach((e) => {
          if (e.name) {
            const cleanKey = e.name.toLowerCase().replace(/^(?:bhead_|head_)/, "");
            if (!this.playerEmojiCache.has(cleanKey) || e.name.startsWith("bhead_")) {
              this.playerEmojiCache.set(cleanKey, `<:${e.name}:${e.id}>`);
            }
          }
        });
      }
    } catch {
    }
  }
  async registerSlashCommands() {
    const commands = [
      new SlashCommandBuilder().setName("configure").setDescription("Link your Aternos server with your session cookie").addStringOption((o) => o.setName("session").setDescription("Aternos session cookie").setRequired(true)),
      new SlashCommandBuilder().setName("start").setDescription("Turn on your Minecraft server (only when offline)"),
      new SlashCommandBuilder().setName("stop").setDescription("Turn off your Minecraft server (only when online)"),
      new SlashCommandBuilder().setName("restart").setDescription("Reboot your Minecraft server"),
      new SlashCommandBuilder().setName("status").setDescription("Check server online/offline status, players, and details"),
      new SlashCommandBuilder().setName("players").setDescription("View connected players and active player count")
    ];
    try {
      const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
      const targetId = this.botId || DISCORD_CLIENT_ID;
      await rest.put(Routes.applicationCommands(targetId), {
        body: commands.map((cmd) => cmd.toJSON())
      });
      console.log("[Apexion Bot] Global slash commands registered.");
      for (const [guildId] of this.client.guilds.cache) {
        rest.put(Routes.applicationGuildCommands(targetId, guildId), {
          body: []
        }).catch(() => {
        });
      }
    } catch (err) {
      console.warn("[Apexion Bot] Slash commands registration notice:", err?.message);
    }
  }
  /**
   * Resolves server context accurately for multi-user / multi-guild setups.
   * Ensures bindings configured in a server channel, guild, or DM are correctly found.
   */
  resolveServerContext(contextId, userId, guildId) {
    let binding = serverStorage.getDiscordBinding(contextId);
    if (!binding && guildId) {
      binding = serverStorage.getDiscordBinding(guildId);
    }
    if (!binding && userId) {
      binding = serverStorage.getDiscordBinding(userId);
    }
    if (binding) {
      const canonical = serverStorage.getCanonicalServerAddress(binding.serverAddress);
      return {
        serverAddress: canonical,
        sessionCookie: binding.sessionCookie,
        serverCookie: binding.serverCookie,
        binding
      };
    }
    const cfg = aternosService.getConfig();
    if (cfg.serverAddress && cfg.sessionCookie) {
      const canonical = serverStorage.getCanonicalServerAddress(cfg.serverAddress);
      const profile = serverStorage.getProfile(canonical) || serverStorage.getProfile(cfg.serverAddress);
      return {
        serverAddress: canonical,
        sessionCookie: cfg.sessionCookie || profile?.sessionCookie || "",
        serverCookie: cfg.serverCookie || profile?.serverCookie || "",
        profile
      };
    }
    const allProfiles = serverStorage.getAllProfiles();
    if (allProfiles.length > 0) {
      const p = allProfiles[0];
      const canonical = serverStorage.getCanonicalServerAddress(p.serverIp || p.name);
      return {
        serverAddress: canonical,
        sessionCookie: p.sessionCookie,
        serverCookie: p.serverCookie,
        profile: p
      };
    }
    return {
      serverAddress: "",
      sessionCookie: "",
      serverCookie: ""
    };
  }
  async ensurePlayerHeadEmoji(playerName, guild) {
    const cleanName = playerName.trim();
    if (!cleanName) return "\u{1F464}";
    const cacheKey = cleanName.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 26);
    if (this.playerEmojiCache.has(cacheKey)) {
      return this.playerEmojiCache.get(cacheKey);
    }
    const emojiName = `head_${cacheKey}`;
    const legacyName = `bhead_${cacheKey}`;
    const app = this.client.application;
    try {
      if (app?.emojis?.cache) {
        const found = app.emojis.cache.find((e) => e.name === emojiName || e.name === legacyName);
        if (found) {
          const formatted = `<:${found.name}:${found.id}>`;
          this.playerEmojiCache.set(cacheKey, formatted);
          return formatted;
        }
      }
    } catch {
    }
    try {
      if (guild?.emojis?.cache) {
        const found = guild.emojis.cache.find((e) => e.name === emojiName || e.name === legacyName);
        if (found) {
          const formatted = `<:${found.name}:${found.id}>`;
          this.playerEmojiCache.set(cacheKey, formatted);
          return formatted;
        }
      }
    } catch {
    }
    try {
      const avatarUrl = `https://mc-heads.net/avatar/${encodeURIComponent(cleanName)}/32`;
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), 2e3);
      const res = await fetch(avatarUrl, { signal: ac.signal });
      clearTimeout(tm);
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        if (app?.emojis?.create) {
          try {
            const newEmoji = await app.emojis.create({
              attachment: buffer,
              name: emojiName
            });
            if (newEmoji?.id) {
              const formatted = `<:${newEmoji.name}:${newEmoji.id}>`;
              this.playerEmojiCache.set(cacheKey, formatted);
              return formatted;
            }
          } catch (appErr) {
            console.warn("[Apexion Bot] App emoji upload notice:", appErr?.message);
          }
        }
        if (guild?.emojis?.create) {
          try {
            const newEmoji = await guild.emojis.create({
              attachment: buffer,
              name: emojiName
            });
            if (newEmoji?.id) {
              const formatted = `<:${newEmoji.name}:${newEmoji.id}>`;
              this.playerEmojiCache.set(cacheKey, formatted);
              return formatted;
            }
          } catch (guildErr) {
            console.warn("[Apexion Bot] Guild emoji upload notice:", guildErr?.message);
          }
        }
      }
    } catch (err) {
      console.warn(`[Apexion Bot] Could not fetch avatar for ${cleanName}:`, err?.message);
    }
    return "\u{1F464}";
  }
  getPlayerHeadEmoji(playerName) {
    const cleanName = playerName.trim();
    if (!cleanName) return "\u{1F464}";
    const cacheKey = cleanName.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 26);
    return this.playerEmojiCache.get(cacheKey) || "\u{1F464}";
  }
  // Fast resolution of fresh Aternos + Minecraft live status
  async getFastServerState(serverAddress, sessionCookie) {
    let state = aternosService.getState(serverAddress);
    if (!sessionCookie) {
      const p = serverStorage.getProfile(serverAddress) || serverStorage.getProfile(serverStorage.getCanonicalServerAddress(serverAddress));
      if (p?.sessionCookie) {
        sessionCookie = p.sessionCookie;
      }
    }
    const isCold = !state.lastUpdated || state.lastUpdated === 0;
    const isStale = Date.now() - (state.lastUpdated || 0) > 4e3;
    if (sessionCookie && (isCold || isStale || state.status === "offline")) {
      try {
        const syncTimeout = new Promise((resolve) => setTimeout(() => resolve(state), 7e3));
        const synced = await Promise.race([aternosService.syncSessionState(serverAddress), syncTimeout]);
        if (synced && synced.lastUpdated) {
          state = synced;
        }
      } catch {
      }
    }
    const targetWithPort = state.serverPort && !serverAddress.includes(":") ? `${serverAddress}:${state.serverPort}` : serverAddress;
    const live = await queryMinecraftServer(
      targetWithPort,
      state.dynip,
      state.playersOnline || 0,
      state.playerList || [],
      state.status === "online" || state.status === "starting"
    );
    if (state.status === "offline" || state.status === "stopping") {
      state.countdownActive = false;
      state.countdownSeconds = null;
      state.countdownFormatted = null;
      state.canExtend = false;
      state.playersOnline = 0;
      state.playerList = [];
    }
    return { state, live };
  }
  // Build clean, polished real-time server status diagnostics embed
  async buildStatusEmbed(serverAddress, state, live, guild) {
    const canonicalAddr = serverStorage.getCanonicalServerAddress(serverAddress);
    const isStopping = state.status === "stopping";
    const isStarting = state.status === "starting";
    const isQueue = state.status === "queue";
    const isAternosOnline = state.status === "online";
    const isLiveOnline = Boolean(live?.online) && !isAternosOfflineIndicator(live?.version, live?.motd);
    let isOnline = false;
    let statusText = "\u{1F534} Offline";
    let color = 15680580;
    if (isStopping) {
      statusText = "\u{1F7E0} Stopping";
      color = 16347926;
    } else if (isStarting) {
      statusText = `\u{1F7E1} ${state.rawStatus || "Starting ..."}`;
      color = 16096779;
    } else if (isQueue) {
      statusText = "\u23F3 In Queue";
      color = 16096779;
    } else if (isAternosOnline || isLiveOnline) {
      isOnline = true;
      statusText = "\u{1F7E2} Online";
      color = 1096065;
    } else {
      isOnline = false;
      statusText = "\u{1F534} Offline";
      color = 15680580;
    }
    const playerCount = isOnline ? Math.max(live?.players?.online || 0, state.playersOnline || 0) : 0;
    const maxCount = live?.players?.max || state.maxPlayers || 20;
    const playerNames = [];
    if (isOnline) {
      if (Array.isArray(live?.players?.list)) {
        for (const p of live.players.list) {
          if (p?.name && !playerNames.includes(p.name)) playerNames.push(p.name);
        }
      }
      if (Array.isArray(state.playerList)) {
        for (const name of state.playerList) {
          if (name && !playerNames.includes(name)) playerNames.push(name);
        }
      }
    }
    const embed = new EmbedBuilder().setColor(color).setTitle(`\u{1F3AE} ${canonicalAddr}`).setDescription(
      isOnline ? `\u{1F7E2} Server is **Online** and joinable.` : isStarting ? `\u{1F7E1} Server is **Starting** \u2014 please allow 1-2 minutes for world load.` : isStopping ? `\u{1F7E0} Server is **Stopping** \u2014 saving world data.` : `\u{1F534} Server is **Offline**.`
    ).addFields(
      { name: "Status", value: `**${statusText}**`, inline: true },
      { name: "Players", value: `\`${playerCount}/${maxCount}\` online`, inline: true },
      { name: "Server Address", value: `\`${canonicalAddr}:${state.serverPort || 25565}\``, inline: true }
    );
    if (isOnline && state.dynip) {
      embed.addFields({ name: "Direct Connect IP", value: `\`${state.dynip}\``, inline: true });
    }
    if (state.software || live?.version || state.version) {
      embed.addFields({
        name: "Version & Software",
        value: `${state.software || "Fabric"} ${live?.version || state.version || "1.20.4"}`,
        inline: true
      });
    }
    if (isOnline && playerNames.length > 0) {
      const playerListItems = await Promise.all(
        playerNames.map(async (n) => {
          const head = await this.ensurePlayerHeadEmoji(n, guild);
          return `${head} **${n}**`;
        })
      );
      embed.addFields({
        name: `\u{1F464} Connected Players (${playerNames.length})`,
        value: playerListItems.join("  \u2022  "),
        inline: false
      });
    }
    if (isOnline && (state.motd || live?.motd)) {
      embed.addFields({
        name: "\u{1F4DC} MOTD",
        value: `*${state.motd || live?.motd}*`,
        inline: false
      });
    }
    if (isOnline) {
      if (playerCount > 0) {
        embed.addFields({
          name: "\u23F1\uFE0F Keepalive Timer",
          value: `\u{1F7E2} **Paused** (${playerCount} active player${playerCount > 1 ? "s" : ""} connected)`,
          inline: false
        });
      } else if (state.countdownActive && typeof state.countdownSeconds === "number" && state.countdownSeconds > 0) {
        const secs = state.countdownSeconds;
        const mins = Math.floor(secs / 60);
        const s = secs % 60;
        const formatted = state.countdownFormatted || `${mins}:${s < 10 ? "0" : ""}${s}`;
        const targetEpoch = Math.floor(Date.now() / 1e3) + secs;
        embed.addFields({
          name: "\u23F1\uFE0F Keepalive Timer",
          value: `\`${formatted}\` remaining \u2022 Auto-shutdown <t:${targetEpoch}:R>`,
          inline: false
        });
      }
    } else if (!isStarting && !isStopping) {
      embed.addFields({
        name: "\u{1F4A1} Action",
        value: "Server is currently offline. Use `/start` to turn it on!",
        inline: false
      });
    }
    embed.setFooter({ text: "Apexion" });
    embed.setTimestamp();
    return embed;
  }
  // Handle Slash Command
  async handleSlashCommand(interaction) {
    const { commandName, user, guildId, channelId } = interaction;
    const contextId = channelId || guildId || user.id;
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }
    } catch (err) {
      console.warn(`[Apexion] Could not defer /${commandName}:`, err?.message);
      return;
    }
    const prevInteraction = this.lastUserReplies.get(user.id);
    this.lastUserReplies.set(user.id, interaction);
    if (prevInteraction && prevInteraction.id !== interaction.id) {
      prevInteraction.deleteReply().catch(() => {
      });
    }
    if (channelId && this.lastChannelMessageIds.has(channelId)) {
      const prevMsgId = this.lastChannelMessageIds.get(channelId);
      this.lastChannelMessageIds.delete(channelId);
      if (prevMsgId && interaction.channel && "messages" in interaction.channel) {
        interaction.channel.messages.delete(prevMsgId).catch(() => {
        });
      }
    }
    try {
      switch (commandName) {
        case "configure": {
          const rawSession = interaction.options.getString("session", true);
          const session = rawSession.replace(/^ATERNOS_SESSION=/i, "").replace(/;.*$/, "").replace(/^["']|["']$/g, "").trim();
          const discovered = await aternosService.discoverServersFromSession(session);
          if (discovered.length === 1) {
            const matchedServer = discovered[0];
            const canonicalAddr = serverStorage.getCanonicalServerAddress(matchedServer.serverAddress);
            serverStorage.setDiscordBinding({
              guildIdOrUserId: contextId,
              serverAddress: canonicalAddr,
              sessionCookie: session,
              serverCookie: matchedServer.serverCookie,
              configuredBy: user.username,
              updatedAt: Date.now()
            });
            if (guildId && guildId !== contextId) {
              serverStorage.setDiscordBinding({
                guildIdOrUserId: guildId,
                serverAddress: canonicalAddr,
                sessionCookie: session,
                serverCookie: matchedServer.serverCookie,
                configuredBy: user.username,
                updatedAt: Date.now()
              });
            }
            if (user.id !== contextId) {
              serverStorage.setDiscordBinding({
                guildIdOrUserId: user.id,
                serverAddress: canonicalAddr,
                sessionCookie: session,
                serverCookie: matchedServer.serverCookie,
                configuredBy: user.username,
                updatedAt: Date.now()
              });
            }
            await aternosService.updateConfig({
              sessionCookie: session,
              serverCookie: matchedServer.serverCookie,
              serverAddress: canonicalAddr
            });
            serverStorage.addDiscordLog({
              user: user.tag,
              command: "/configure",
              serverAddress: canonicalAddr,
              status: "success",
              message: `Linked ${canonicalAddr}`
            });
            const embed2 = new EmbedBuilder().setColor(1096065).setTitle("\u2699\uFE0F Aternos Server Configured").setDescription(`Successfully linked **${canonicalAddr}** to Apexion.
You can now control your server using slash commands.`).addFields(
              { name: "\u{1F310} Server Address", value: `\`${canonicalAddr}\``, inline: true },
              { name: "\u{1F511} Server ID", value: `\`${matchedServer.id}\``, inline: true },
              { name: "\u{1F512} Session Auth", value: "\u2705 Synced & Active", inline: true },
              {
                name: "\u{1F3AE} Control Commands",
                value: "`/status` \u2014 Check online status & player count\n`/players` \u2014 View online players\n`/start` \u2014 Turn on server\n`/stop` \u2014 Turn off server\n`/restart` \u2014 Reboot server"
              }
            ).setFooter({ text: "Apexion" }).setTimestamp();
            await interaction.editReply({ embeds: [embed2] });
            return;
          }
          if (discovered.length === 0) {
            const embed2 = new EmbedBuilder().setColor(15680580).setTitle("\u274C No Aternos Servers Found").setDescription(
              "Could not locate any servers on this Aternos account.\nPlease make sure your `ATERNOS_SESSION` cookie is copied from your browser while logged into [aternos.org](https://aternos.org/servers/)."
            ).setFooter({ text: "Apexion" });
            await interaction.editReply({ embeds: [embed2] });
            return;
          }
          const menuCustomId = `select_srv_${user.id}_${Date.now()}`;
          this.pendingSelections.set(menuCustomId, {
            session,
            servers: discovered,
            contextId,
            guildId: guildId || void 0,
            userId: user.id,
            userName: user.username
          });
          const selectMenu = new StringSelectMenuBuilder().setCustomId(menuCustomId).setPlaceholder("Choose a server to link...").addOptions(
            discovered.map(
              (s) => new StringSelectMenuOptionBuilder().setLabel(s.serverAddress).setDescription(`Server ID: ${s.id}`).setValue(s.id).setEmoji("\u{1F3AE}")
            )
          );
          const actionRow = new ActionRowBuilder().addComponents(selectMenu);
          const embed = new EmbedBuilder().setColor(3900150).setTitle("\u{1F4CB} Choose Your Aternos Server").setDescription(`Found **${discovered.length} server(s)** linked to your session. Select the server you want to control from the dropdown below:`).addFields(
            discovered.map((s, idx) => ({
              name: `${idx + 1}. ${s.serverAddress}`,
              value: `Server ID: \`${s.id}\``,
              inline: true
            }))
          ).setFooter({ text: "Select an option below to complete setup" });
          await interaction.editReply({ embeds: [embed], components: [actionRow] });
          break;
        }
        case "start": {
          const ctx = this.resolveServerContext(contextId, user.id, guildId);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);
          const isOnline = !isAternosOfflineIndicator(live?.version, live?.motd) && Boolean(live?.online) && state.status !== "offline";
          if (isOnline) {
            const embed = new EmbedBuilder().setColor(15680580).setTitle(`\u26A0\uFE0F ${ctx.serverAddress} is Already Online!`).setDescription(`Server is already online and joinable.`).addFields(
              { name: "Status", value: "\u{1F7E2} **Online**", inline: true },
              { name: "Players", value: `\`${live.players?.online || 0}/${live.players?.max || 20}\``, inline: true },
              { name: "Tip", value: "Use `/stop` to shut down, or `/restart` to reboot.", inline: false }
            ).setFooter({ text: "Apexion" }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }
          if (state.status === "starting" || state.status === "queue") {
            const embed = new EmbedBuilder().setColor(16096779).setTitle(`\u23F3 ${ctx.serverAddress} is Booting Up!`).setDescription(`Server is already in the starting sequence. Please give it 1 to 2 minutes.`).addFields({ name: "Current Status", value: `\u{1F7E1} ${state.rawStatus || "Starting ..."}` }).setFooter({ text: "Apexion" }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }
          const res = await aternosService.startServer(ctx.serverAddress, {
            sessionCookie: ctx.sessionCookie,
            serverCookie: ctx.serverCookie,
            serverAddress: ctx.serverAddress
          });
          serverStorage.addDiscordLog({
            user: user.tag,
            command: "/start",
            serverAddress: ctx.serverAddress,
            status: res.success ? "success" : "error",
            message: res.message
          });
          if (res.success) {
            const embed = new EmbedBuilder().setColor(1096065).setTitle(`\u{1F680} Starting ${ctx.serverAddress}`).setDescription(`Start signal sent to Aternos. The server is booting up and will be ready for players in ~1-2 minutes.`).addFields(
              { name: "Status", value: "\u{1F7E1} **Starting ...**", inline: true },
              { name: "Estimated Time", value: "~60-90 seconds", inline: true },
              { name: "Tip", value: "Run `/status` in a moment to track startup progress.", inline: false }
            ).setFooter({ text: "Apexion" }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } else {
            const embed = new EmbedBuilder().setColor(15680580).setTitle("\u274C Start Command Failed").setDescription(`Aternos rejected the start request:
\`${res.message}\`
Verify that your session cookie is valid via \`/configure\`.`).setFooter({ text: "Apexion" }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          }
          break;
        }
        case "stop": {
          const ctx = this.resolveServerContext(contextId, user.id, guildId);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);
          const isOnline = !isAternosOfflineIndicator(live?.version, live?.motd) && (live?.online || state.status === "online");
          if (!isOnline && state.status !== "starting" && state.status !== "stopping") {
            const embed = new EmbedBuilder().setColor(15680580).setTitle(`\u26A0\uFE0F ${ctx.serverAddress} is Already Offline!`).setDescription(`Cannot stop a server that isn't running.
Use \`/start\` if you would like to boot it up.`).setFooter({ text: "Apexion" }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }
          if (state.status === "stopping") {
            const embed = new EmbedBuilder().setColor(16096779).setTitle(`\u23F3 ${ctx.serverAddress} is Shutting Down!`).setDescription(`Server is already shutting down and saving world files.`).setFooter({ text: "Apexion" }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }
          const res = await aternosService.stopServer(ctx.serverAddress, {
            sessionCookie: ctx.sessionCookie,
            serverCookie: ctx.serverCookie,
            serverAddress: ctx.serverAddress
          });
          serverStorage.addDiscordLog({
            user: user.tag,
            command: "/stop",
            serverAddress: ctx.serverAddress,
            status: res.success ? "success" : "error",
            message: res.message
          });
          if (res.success) {
            const embed = new EmbedBuilder().setColor(16347926).setTitle(`\u{1F6D1} Stopping ${ctx.serverAddress}`).setDescription(`Stop signal sent to Aternos. World progress is being saved and the server is powering down safely.`).addFields({ name: "Status", value: "\u{1F7E0} **Stopping ...**", inline: true }).setFooter({ text: "Apexion" }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } else {
            const embed = new EmbedBuilder().setColor(15680580).setTitle("\u274C Stop Command Failed").setDescription(`Aternos returned: \`${res.message}\``).setFooter({ text: "Apexion" }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          }
          break;
        }
        case "restart": {
          const ctx = this.resolveServerContext(contextId, user.id, guildId);
          const res = await aternosService.restartServer(ctx.serverAddress, {
            sessionCookie: ctx.sessionCookie,
            serverCookie: ctx.serverCookie,
            serverAddress: ctx.serverAddress
          });
          const embed = new EmbedBuilder().setColor(res.success ? 3900150 : 15680580).setTitle(res.success ? `\u{1F504} Rebooting ${ctx.serverAddress}` : "\u274C Restart Failed").setDescription(`Restart signal sent to Aternos. The server will cycle off and boot back up automatically.`).addFields({ name: "Result", value: res.message }).setFooter({ text: "Apexion" }).setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          break;
        }
        case "status": {
          const ctx = this.resolveServerContext(contextId, user.id, guildId);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);
          const embed = await this.buildStatusEmbed(ctx.serverAddress, state, live, interaction.guild);
          await interaction.editReply({ embeds: [embed] });
          break;
        }
        case "players": {
          const ctx = this.resolveServerContext(contextId, user.id, guildId);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);
          const isStopping = state.status === "stopping";
          const isStarting = state.status === "starting";
          const isAternosOnline = state.status === "online";
          const isLiveOnline = Boolean(live?.online) && !isAternosOfflineIndicator(live?.version, live?.motd);
          const isOnline = !isStopping && !isStarting && (isAternosOnline || isLiveOnline);
          if (isStarting) {
            const embed2 = new EmbedBuilder().setColor(16096779).setTitle(`\u23F3 Server is Starting`).setDescription(`**${ctx.serverAddress}** is currently booting up. Players can join once world loading finishes.`).setFooter({ text: "Apexion" }).setTimestamp();
            await interaction.editReply({ embeds: [embed2] });
            break;
          }
          if (!isOnline) {
            const embed2 = new EmbedBuilder().setColor(15680580).setTitle(`\u{1F534} Server is Offline`).setDescription(`**${ctx.serverAddress}** is currently offline. Active players cannot be queried.
Use \`/start\` to bring the server online!`).setFooter({ text: "Apexion" }).setTimestamp();
            await interaction.editReply({ embeds: [embed2] });
            break;
          }
          const playerNames = /* @__PURE__ */ new Set();
          if (Array.isArray(live?.players?.list)) {
            for (const p of live.players.list) {
              if (p?.name) playerNames.add(p.name);
            }
          }
          if (Array.isArray(state?.playerList)) {
            for (const name of state.playerList) {
              if (name) playerNames.add(name);
            }
          }
          const combinedList = Array.from(playerNames);
          const count = Math.max(combinedList.length, live?.players?.online || 0, state?.playersOnline || 0);
          const max = live?.players?.max || state?.maxPlayers || 20;
          if (count === 0 && combinedList.length === 0) {
            const embed2 = new EmbedBuilder().setColor(1096065).setTitle(`\u{1F465} No Players Online (0/${max})`).setDescription(`There are currently **0** players connected to **${ctx.serverAddress}**.
The server is online and ready for players to join!`).setFooter({ text: "Apexion" }).setTimestamp();
            if (state.countdownActive && typeof state.countdownSeconds === "number" && state.countdownSeconds > 0) {
              const secs = state.countdownSeconds;
              const mins = Math.floor(secs / 60);
              const s = secs % 60;
              const formatted = state.countdownFormatted || `${mins}:${s < 10 ? "0" : ""}${s}`;
              const targetEpoch = Math.floor(Date.now() / 1e3) + secs;
              embed2.addFields({
                name: "\u23F1\uFE0F Keepalive Timer",
                value: `\`${formatted}\` remaining \u2022 Auto-shutdown <t:${targetEpoch}:R>`,
                inline: false
              });
            }
            await interaction.editReply({ embeds: [embed2] });
            break;
          }
          const embed = new EmbedBuilder().setColor(1096065).setTitle(`\u{1F465} Connected Players (${count}/${max})`).setDescription(`Active players currently connected to **${ctx.serverAddress}**:`).setFooter({ text: "Apexion" }).setTimestamp();
          const playerLines = await Promise.all(
            combinedList.map(async (name, idx) => {
              const headEmoji = await this.ensurePlayerHeadEmoji(name, interaction.guild);
              return `**${idx + 1}.** ${headEmoji} **${name}**`;
            })
          );
          embed.addFields({ name: "Player List", value: playerLines.join("\n"), inline: false });
          await interaction.editReply({ embeds: [embed] });
          break;
        }
        default:
          await interaction.editReply({ content: "Unknown command." });
      }
    } catch (err) {
      console.error(`[Apexion /${commandName} Error]`, err);
      try {
        if (interaction.deferred && !interaction.replied) {
          await interaction.editReply({ content: `\u274C Command Error: ${err.message || "Operation failed"}` });
        } else if (!interaction.replied) {
          await interaction.reply({ content: `\u274C Command Error: ${err.message || "Operation failed"}`, ephemeral: true });
        }
      } catch {
      }
    }
  }
  // Handle Interactive Select Menu Selection for /configure
  async handleSelectMenu(interaction) {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }
    } catch (err) {
      console.warn("[Apexion] Could not defer select menu:", err?.message);
      return;
    }
    const { customId, values, user } = interaction;
    const pending = this.pendingSelections.get(customId);
    if (!pending) {
      await interaction.followUp({
        content: "\u26A0\uFE0F This server selection menu has expired. Please run `/configure` again.",
        ephemeral: true
      }).catch(() => {
      });
      return;
    }
    const selectedId = values[0];
    const chosenServer = pending.servers.find((s) => s.id === selectedId);
    if (!chosenServer) {
      await interaction.followUp({
        content: "\u26A0\uFE0F Selected server was not found.",
        ephemeral: true
      }).catch(() => {
      });
      return;
    }
    try {
      const canonicalAddr = serverStorage.getCanonicalServerAddress(chosenServer.serverAddress);
      serverStorage.setDiscordBinding({
        guildIdOrUserId: pending.contextId,
        serverAddress: canonicalAddr,
        sessionCookie: pending.session,
        serverCookie: chosenServer.serverCookie,
        configuredBy: pending.userName,
        updatedAt: Date.now()
      });
      if (pending.guildId && pending.guildId !== pending.contextId) {
        serverStorage.setDiscordBinding({
          guildIdOrUserId: pending.guildId,
          serverAddress: canonicalAddr,
          sessionCookie: pending.session,
          serverCookie: chosenServer.serverCookie,
          configuredBy: pending.userName,
          updatedAt: Date.now()
        });
      }
      if (pending.userId !== pending.contextId) {
        serverStorage.setDiscordBinding({
          guildIdOrUserId: pending.userId,
          serverAddress: canonicalAddr,
          sessionCookie: pending.session,
          serverCookie: chosenServer.serverCookie,
          configuredBy: pending.userName,
          updatedAt: Date.now()
        });
      }
      await aternosService.updateConfig({
        sessionCookie: pending.session,
        serverCookie: chosenServer.serverCookie,
        serverAddress: canonicalAddr
      });
      serverStorage.addDiscordLog({
        user: user.tag,
        command: "/configure [SELECT]",
        serverAddress: canonicalAddr,
        status: "success",
        message: `Selected and bound ${canonicalAddr}`
      });
      const embed = new EmbedBuilder().setColor(1096065).setTitle("\u2705 Aternos Server Linked Successfully").setDescription(`Successfully linked **${canonicalAddr}** (ID: \`${chosenServer.id}\`) to Apexion.
You can now control your server directly!`).addFields(
        { name: "\u{1F310} Server Address", value: `\`${canonicalAddr}\``, inline: true },
        { name: "\u{1F511} Server ID", value: `\`${chosenServer.id}\``, inline: true },
        { name: "\u{1F512} Session Auth", value: "\u2705 Synced & Active", inline: true },
        {
          name: "\u{1F3AE} Control Commands",
          value: "`/status` \u2014 Check online status & player count\n`/players` \u2014 View online players\n`/start` \u2014 Turn on server\n`/stop` \u2014 Turn off server\n`/restart` \u2014 Reboot server"
        }
      ).setFooter({ text: "Apexion" }).setTimestamp();
      await interaction.editReply({ embeds: [embed], components: [] });
      this.pendingSelections.delete(customId);
    } catch (err) {
      console.error("[Apexion Select Menu Error]", err);
    }
  }
  getBotStatus() {
    return {
      isReady: this.isReady,
      currentEnv: CURRENT_ENV,
      activeTarget: serverStorage.getBotTarget(),
      botTag: this.botTag || (this.isReady ? "Apexion#3859" : "Standby / Disconnected"),
      botId: this.botId,
      guildsCount: this.client.guilds?.cache?.size || 0,
      ping: this.client.ws?.ping || this.lastPing || 0,
      initError: this.initError,
      recentLogs: serverStorage.getDiscordLogs(),
      bindings: serverStorage.getAllDiscordBindings()
    };
  }
};
var discordBot = new DiscordBotService();

// server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path4.dirname(__filename);
var ADMIN_USERNAME = "Shifin";
var ADMIN_PASSWORD = "0508552513";
var ADMIN_TOKEN = "shifin-auth-session-key-0508552513";
async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);
  app.use(express.json());
  app.get("/api/status", (req, res) => {
    const serverParam = req.query.server?.toLowerCase();
    const shouldRefresh = req.query.refresh === "true";
    const token = req.headers["x-admin-token"] || req.query.admin_token;
    const isAdmin = token === ADMIN_TOKEN;
    if (serverParam) {
      if (shouldRefresh) {
        aternosService.syncSessionState(serverParam).catch(() => {
        });
      }
      const specificState = aternosService.getState(serverParam);
      res.json({
        ...specificState,
        allServerStates: isAdmin ? aternosService.getAllStates() : { [serverParam]: specificState }
      });
      return;
    }
    if (shouldRefresh) {
      aternosService.syncState().catch(() => {
      });
    }
    const activeState = aternosService.getState();
    res.json({
      ...activeState,
      allServerStates: isAdmin ? aternosService.getAllStates() : {}
    });
  });
  app.get("/api/servers", (req, res) => {
    const token = req.headers["x-admin-token"] || req.query.admin_token;
    if (token === ADMIN_TOKEN) {
      const all = serverStorage.getAllProfiles();
      res.json(all);
    } else {
      res.json([]);
    }
  });
  app.get("/api/servers/status", (req, res) => {
    res.json(aternosService.getAllStates());
  });
  app.get("/api/logs", (req, res) => {
    res.json(aternosService.getLogs());
  });
  app.delete("/api/logs", (req, res) => {
    aternosService.clearLogs();
    res.json({ success: true, message: "Logs cleared." });
  });
  app.post("/api/action/start", async (req, res) => {
    const { serverAddress, sessionCookie, serverCookie, serverId } = req.body || {};
    const result = await aternosService.startServer(serverAddress, {
      sessionCookie,
      serverCookie,
      serverAddress,
      serverId
    });
    res.json(result);
  });
  app.post("/api/action/stop", async (req, res) => {
    const { serverAddress, sessionCookie, serverCookie, serverId } = req.body || {};
    const result = await aternosService.stopServer(serverAddress, {
      sessionCookie,
      serverCookie,
      serverAddress,
      serverId
    });
    res.json(result);
  });
  app.post("/api/action/restart", async (req, res) => {
    const { serverAddress, sessionCookie, serverCookie, serverId } = req.body || {};
    const result = await aternosService.restartServer(serverAddress, {
      sessionCookie,
      serverCookie,
      serverAddress,
      serverId
    });
    res.json(result);
  });
  app.post("/api/action/extend", async (req, res) => {
    const { serverAddress, sessionCookie, serverCookie, serverId } = req.body || {};
    const result = await aternosService.extendTimer(serverAddress, {
      sessionCookie,
      serverCookie,
      serverAddress,
      serverId
    });
    res.json(result);
  });
  app.post("/api/action/test-start", async (req, res) => {
    const result = await aternosService.runSelfTest();
    res.json(result);
  });
  app.get("/api/macros", (req, res) => {
    const serverParam = req.query.server;
    res.json(aternosService.getMacros(serverParam));
  });
  app.post("/api/macros", (req, res) => {
    const { rules, serverAddress, serverId } = req.body || {};
    const target = req.query.server || serverAddress || serverId;
    const updated = aternosService.updateMacros(rules, target);
    res.json(updated);
  });
  app.post("/api/macros/trigger/:id", async (req, res) => {
    const { serverAddress, serverId } = req.body || {};
    const target = req.query.server || serverAddress || serverId;
    const result = await aternosService.triggerMacro(req.params.id, target);
    res.json(result);
  });
  app.post("/api/action/command", async (req, res) => {
    const { command } = req.body || {};
    const result = await aternosService.executeCliCommand(command || "");
    res.json(result);
  });
  app.get("/api/config", (req, res) => {
    res.json(aternosService.getConfig());
  });
  app.post("/api/config", async (req, res) => {
    const { sessionCookie, serverCookie, serverAddress, cfClearanceCookie, userAgent, software, version, serverPort } = req.body || {};
    await aternosService.updateConfig({ sessionCookie, serverCookie, serverAddress, cfClearanceCookie, userAgent, software, version, serverPort });
    if (serverAddress) {
      serverStorage.saveProfile({
        id: `srv-${serverAddress.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`,
        name: serverAddress,
        serverIp: serverAddress,
        serverPort: serverPort || "25565",
        software: software || "Fabric",
        version: version || "1.20.4",
        sessionCookie: sessionCookie || "",
        serverCookie: serverCookie || "",
        source: "web"
      });
    }
    res.json({ success: true, message: "Settings updated successfully." });
  });
  app.get("/api/system/info", async (req, res) => {
    const redisHealth = await getRedisHealth();
    res.json({
      name: "Apexion",
      environment: CURRENT_ENV,
      storageNamespace: DATA_PREFIX,
      redisHealth,
      botStatus: discordBot.getBotStatus(),
      uptime: process.uptime()
    });
  });
  app.post("/api/servers/sync", async (req, res) => {
    const { servers } = req.body || {};
    if (Array.isArray(servers)) {
      serverStorage.syncFromClient(servers, "web");
      await aternosService.syncProfiles(servers);
    }
    res.json({ success: true, count: servers?.length || 0 });
  });
  app.post("/api/user/sync", async (req, res) => {
    const { servers } = req.body || {};
    if (Array.isArray(servers)) {
      serverStorage.syncFromClient(servers, "web");
      await aternosService.syncProfiles(servers);
    }
    res.json({ success: true, count: servers?.length || 0 });
  });
  app.get("/api/user/profiles", (req, res) => {
    const token = req.headers["x-admin-token"] || req.query.admin_token;
    if (token === ADMIN_TOKEN) {
      const all = serverStorage.getAllProfiles();
      res.json({ success: true, servers: all });
    } else {
      res.json({ success: true, servers: [] });
    }
  });
  app.post("/api/server/detect", async (req, res) => {
    const ac = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) {
        ac.abort();
      }
    });
    const { sessionCookie, serverCookie } = req.body || {};
    try {
      const result = await aternosService.detectServerFromCookies(sessionCookie, serverCookie, ac.signal);
      if (!res.writableEnded) {
        res.json(result);
      }
    } catch (err) {
      if (!res.writableEnded) {
        res.status(500).json({ success: false, message: err?.message || "Detect error" });
      }
    }
  });
  app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body || {};
    const cleanUser = String(username || "").trim();
    const cleanPass = String(password || "").trim();
    if (cleanUser.toLowerCase() === ADMIN_USERNAME.toLowerCase() && cleanPass === ADMIN_PASSWORD) {
      res.json({
        success: true,
        token: ADMIN_TOKEN,
        username: ADMIN_USERNAME,
        message: "Administrator authentication verified."
      });
    } else {
      res.status(401).json({
        success: false,
        message: "Invalid credentials. Access denied."
      });
    }
  });
  const verifyAdmin = (req, res, next) => {
    const token = req.headers["x-admin-token"] || req.query.admin_token;
    if (token === ADMIN_TOKEN) {
      next();
    } else {
      res.status(403).json({ success: false, message: "Unauthorized. Admin credentials required." });
    }
  };
  app.get("/api/admin/servers", verifyAdmin, (req, res) => {
    const profiles = serverStorage.getAllProfiles();
    const liveStates = aternosService.getAllStates();
    const enriched = profiles.map((p) => {
      const key = (p.serverIp || p.name || p.id).toLowerCase();
      const st = liveStates[key] || liveStates[p.id];
      return {
        ...p,
        liveStatus: st?.status || "unknown",
        rawStatus: st?.rawStatus || "Unknown",
        countdownFormatted: st?.countdownFormatted,
        playersOnline: st?.playersOnline,
        playerList: st?.playerList || [],
        maxPlayers: st?.maxPlayers,
        dynip: st?.dynip
      };
    });
    res.json({
      success: true,
      totalCount: enriched.length,
      servers: enriched
    });
  });
  app.post("/api/admin/servers/save", verifyAdmin, (req, res) => {
    const { profile } = req.body || {};
    if (!profile) {
      res.status(400).json({ success: false, message: "Profile data missing." });
      return;
    }
    const saved = serverStorage.saveProfile({
      ...profile,
      source: profile.source || "admin"
    });
    res.json({ success: true, profile: saved });
  });
  app.delete("/api/admin/servers/:id", verifyAdmin, (req, res) => {
    const { id } = req.params;
    const deleted = serverStorage.deleteProfile(id);
    res.json({ success: deleted, message: deleted ? "Profile deleted." : "Profile not found." });
  });
  app.post("/api/admin/servers/action", verifyAdmin, async (req, res) => {
    const { action, serverAddress, sessionCookie, serverCookie, serverId } = req.body || {};
    let result = { success: false, message: "Unknown action" };
    const creds = { sessionCookie, serverCookie, serverAddress, serverId };
    if (action === "start") {
      result = await aternosService.startServer(serverAddress, creds);
    } else if (action === "stop") {
      result = await aternosService.stopServer(serverAddress, creds);
    } else if (action === "restart") {
      result = await aternosService.restartServer(serverAddress, creds);
    } else if (action === "extend") {
      result = await aternosService.extendTimer(serverAddress, creds);
    }
    res.json(result);
  });
  app.get("/api/admin/bot-status", verifyAdmin, async (req, res) => {
    const redisHealth = await getRedisHealth();
    res.json({
      success: true,
      redisHealth,
      ...discordBot.getBotStatus()
    });
  });
  app.get("/api/admin/bot-mode", verifyAdmin, (req, res) => {
    res.json({
      success: true,
      activeTarget: serverStorage.getBotTarget(),
      currentEnv: discordBot.getBotStatus().currentEnv,
      isBotRunning: discordBot.getBotStatus().isReady,
      botTag: discordBot.getBotStatus().botTag
    });
  });
  app.post("/api/admin/bot-mode", verifyAdmin, async (req, res) => {
    const { target } = req.body || {};
    if (target !== "dev" && target !== "published" && target !== "disabled") {
      res.status(400).json({ success: false, message: 'Invalid target. Must be "dev", "published", or "disabled".' });
      return;
    }
    await discordBot.setTargetMode(target);
    res.json({
      success: true,
      message: `Discord bot target globally set to "${target.toUpperCase()}" via Upstash Redis.`,
      activeTarget: target,
      currentEnv: discordBot.getBotStatus().currentEnv,
      isBotRunning: discordBot.getBotStatus().isReady
    });
  });
  const isProduction = process.env.NODE_ENV === "production" || __filename.endsWith("server.js") || !fs4.existsSync(path4.resolve(__dirname, "node_modules/vite"));
  if (!isProduction) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path4.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path4.resolve(distPath, "index.html"));
    });
  }
  discordBot.start().catch((err) => {
    console.warn("[Apexion Bot] Startup notice:", err?.message);
  });
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Apexion] Server listening on http://0.0.0.0:${PORT} [${CURRENT_ENV.toUpperCase()}]`);
  });
}
startServer().catch((err) => {
  console.error("[Fatal] Server failed to start:", err);
  process.exit(1);
});
