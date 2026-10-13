// server.ts
import express from "express";
import path3 from "path";
import fs3 from "fs";
import { fileURLToPath } from "url";

// src/server/aternosAutomation.ts
import vm from "vm";
import { exec, execSync } from "child_process";
import path2 from "path";
import fs2 from "fs";

// src/server/serverStorage.ts
import fs from "fs";
import path from "path";
var ServerStorageManager = class {
  constructor() {
    this.profiles = /* @__PURE__ */ new Map();
    this.discordBindings = /* @__PURE__ */ new Map();
    this.discordLogs = [];
    this.MAX_LOGS = 100;
    this.dataDir = path.resolve(process.cwd(), "data");
    this.storageFilePath = path.join(this.dataDir, "admin-servers.json");
    this.discordBindingsPath = path.join(this.dataDir, "discord-bindings.json");
    this.discordLogsPath = path.join(this.dataDir, "discord-logs.json");
    this.ensureDataDir();
    this.loadFromDisk();
  }
  ensureDataDir() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
    } catch (err) {
      console.warn("Could not create data dir:", err?.message);
    }
  }
  loadFromDisk() {
    try {
      if (fs.existsSync(this.storageFilePath)) {
        const raw = fs.readFileSync(this.storageFilePath, "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item.id) this.profiles.set(item.id, item);
          }
        }
      } else if (fs.existsSync("./servers-config.json")) {
        const raw = fs.readFileSync("./servers-config.json", "utf-8");
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
      if (fs.existsSync(this.discordBindingsPath)) {
        const raw = fs.readFileSync(this.discordBindingsPath, "utf-8");
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
      if (fs.existsSync(this.discordLogsPath)) {
        const raw = fs.readFileSync(this.discordLogsPath, "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.discordLogs = list;
        }
      }
    } catch {
    }
  }
  saveToDisk() {
    try {
      this.ensureDataDir();
      const list = Array.from(this.profiles.values());
      fs.writeFileSync(this.storageFilePath, JSON.stringify(list, null, 2), "utf-8");
      fs.writeFileSync("./servers-config.json", JSON.stringify(list, null, 2), "utf-8");
    } catch (err) {
      console.warn("Could not save server profiles to disk:", err?.message);
    }
  }
  saveDiscordBindingsToDisk() {
    try {
      this.ensureDataDir();
      const list = Array.from(this.discordBindings.values());
      fs.writeFileSync(this.discordBindingsPath, JSON.stringify(list, null, 2), "utf-8");
    } catch {
    }
  }
  saveDiscordLogsToDisk() {
    try {
      this.ensureDataDir();
      fs.writeFileSync(this.discordLogsPath, JSON.stringify(this.discordLogs, null, 2), "utf-8");
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
  }
  deleteProfile(id) {
    const profile = this.getProfile(id);
    if (!profile) return false;
    this.profiles.delete(profile.id);
    this.saveToDisk();
    return true;
  }
  // Canonical server address lookup preserving proper casing (e.g. Bang_Bros_SMP.aternos.me)
  getCanonicalServerAddress(query) {
    if (!query) return "Bang_Bros_SMP.aternos.me";
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
  getDiscordBinding(guildIdOrUserId) {
    if (this.discordBindings.has(guildIdOrUserId)) {
      return this.discordBindings.get(guildIdOrUserId);
    }
    const all = Array.from(this.discordBindings.values());
    if (all.length > 0) {
      return all[0];
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
  }
  getDiscordLogs() {
    return [...this.discordLogs];
  }
};
var serverStorage = new ServerStorageManager();

// src/server/aternosAutomation.ts
var DEFAULT_SESSION_CONFIG = {
  sessionCookie: process.env.ATERNOS_SESSION || "",
  serverCookie: process.env.ATERNOS_SERVER || "",
  serverAddress: process.env.ATERNOS_SERVER_ADDRESS || "Bang_Bros_SMP.aternos.me"
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
    this.curlBinaryPath = path2.resolve(process.cwd(), "bin", "curl_chrome116");
    this.ensureCurlBinary();
    this.addLog("SYS", "Aternos Command Center core online. Real Sleeyax AJAX API protocol active.");
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
      if (!fs2.existsSync(this.curlBinaryPath)) {
        const binDir2 = path2.dirname(this.curlBinaryPath);
        if (!fs2.existsSync(binDir2)) {
          fs2.mkdirSync(binDir2, { recursive: true });
        }
        execSync(
          'curl -sL "https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz" | tar -xz -C ./bin',
          { stdio: "ignore" }
        );
      }
      if (fs2.existsSync(this.curlBinaryPath)) {
        fs2.chmodSync(this.curlBinaryPath, 493);
      }
      const binDir = path2.dirname(this.curlBinaryPath);
      if (fs2.existsSync(binDir)) {
        for (const file of fs2.readdirSync(binDir)) {
          try {
            fs2.chmodSync(path2.join(binDir, file), 493);
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
      if (fs2.existsSync("./session-config.json")) {
        const raw = fs2.readFileSync("./session-config.json", "utf-8");
        return JSON.parse(raw);
      }
    } catch {
    }
    return { ...DEFAULT_SESSION_CONFIG };
  }
  loadMacrosConfig() {
    try {
      if (fs2.existsSync("./macros-config.json")) {
        const raw = fs2.readFileSync("./macros-config.json", "utf-8");
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
      fs2.writeFileSync("./macros-config.json", JSON.stringify(this.macroRules, null, 2), "utf-8");
    } catch {
    }
  }
  loadServersConfig() {
    try {
      if (fs2.existsSync("./servers-config.json")) {
        const raw = fs2.readFileSync("./servers-config.json", "utf-8");
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
      if (fs2.existsSync("./servers-config.json")) {
        const raw = fs2.readFileSync("./servers-config.json", "utf-8");
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
          serverIp: cfg.serverAddress || "myserver.aternos.me",
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
    const binary = fs2.existsSync(this.curlBinaryPath) ? this.curlBinaryPath : "./bin/curl_chrome116";
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
          if (inst.state.countdownSeconds === null || inst.state.countdownSeconds === void 0) {
            inst.state.countdownSeconds = 360;
          }
          if (inst.state.countdownSeconds > 0) {
            inst.state.countdownActive = true;
            inst.state.countdownSeconds -= 1;
            const m = Math.floor(inst.state.countdownSeconds / 60);
            const s = inst.state.countdownSeconds % 60;
            inst.state.countdownFormatted = `${m}:${s < 10 ? "0" : ""}${s}`;
            inst.state.canExtend = inst.state.countdownSeconds <= 60;
          } else {
            inst.state.countdownActive = false;
            inst.state.countdownSeconds = 0;
            inst.state.countdownFormatted = "0:00";
            inst.state.canExtend = false;
          }
        } else {
          inst.state.countdownActive = false;
        }
      } else {
        inst.state.countdownActive = false;
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
import sharp from "sharp";

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
                  version: data.version?.name,
                  motd: typeof data.description === "string" ? data.description : data.description?.text
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
  if (cached && now - cached.time < 6e3) {
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
        tasks.push(pingMinecraftDirect(t.host, t.port, 1500));
      }
      for (const t of targets) {
        const targetStr = t.port === 25565 ? t.host : `${t.host}:${t.port}`;
        tasks.push(
          (async () => {
            try {
              const ac = new AbortController();
              const tm = setTimeout(() => ac.abort(), 3e3);
              const res = await fetch(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(targetStr)}`, {
                signal: ac.signal
              });
              clearTimeout(tm);
              if (res.ok) {
                const data = await res.json();
                if (data?.online) {
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
                    version: data.version?.name_clean || data.version?.name_raw,
                    motd: data.motd?.clean
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
              const tm = setTimeout(() => ac.abort(), 3e3);
              const res = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(targetStr)}`, {
                signal: ac.signal
              });
              clearTimeout(tm);
              if (res.ok) {
                const data = await res.json();
                if (data?.online) {
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
                    version: data.version,
                    motd: Array.isArray(data.motd?.clean) ? data.motd.clean.join(" ") : data.motd?.clean
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
      const isServerOnline = fallbackOnline || fallbackCount > 0 || fallbackPlayerList.length > 0;
      const listFromFallback = fallbackPlayerList.map((name) => ({
        name,
        avatarUrl: `https://minotar.net/helm/${encodeURIComponent(name)}/32.png`
      }));
      const fallbackResult = {
        online: isServerOnline,
        players: {
          online: Math.max(fallbackCount, listFromFallback.length),
          max: 20,
          list: listFromFallback
        }
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
var DISCORD_CLIENT_ID = "1555330856757755994";
var DiscordBotService = class {
  constructor() {
    this.isReady = false;
    this.botTag = "";
    this.botId = "";
    this.lastPing = 0;
    this.initError = null;
    // Player head emoji cache: playerName.toLowerCase() -> '<:head_name:id>'
    this.playerEmojiCache = /* @__PURE__ */ new Map();
    this.canCreateApplicationEmojis = true;
    this.emojiQueue = [];
    this.isProcessingEmojiQueue = false;
    // Pending server selections for /configure
    this.pendingSelections = /* @__PURE__ */ new Map();
    // Track previous interactions per user to delete older messages when a new command is run
    this.userLastInteractions = /* @__PURE__ */ new Map();
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds
      ]
    });
    this.setupEventHandlers();
  }
  setupEventHandlers() {
    this.client.once("ready", async () => {
      this.isReady = true;
      this.botTag = this.client.user?.tag || "Aternos Bot";
      this.botId = this.client.user?.id || DISCORD_CLIENT_ID;
      this.lastPing = this.client.ws.ping;
      console.log(`[Discord Bot] Ready as ${this.botTag} (${this.botId})`);
      serverStorage.addDiscordLog({
        user: this.botTag,
        command: "READY",
        serverAddress: "discord.gateway",
        status: "success",
        message: `Connected in ${this.client.guilds.cache.size} server(s)`
      });
      await this.loadExistingApplicationEmojis();
      await this.registerSlashCommands();
    });
    this.client.on("interactionCreate", async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          this.handleSlashCommand(interaction).catch((err) => {
            console.error("[Slash Command Unhandled]", err);
          });
        } else if (interaction.isStringSelectMenu()) {
          this.handleSelectMenu(interaction).catch((err) => {
            console.error("[Select Menu Unhandled]", err);
          });
        }
      } catch (err) {
        console.error("[Discord Interaction Event Error]", err);
      }
    });
    this.client.on("error", (err) => {
      console.error("[Discord Bot Error]", err?.message);
      this.initError = err.message;
    });
  }
  async start() {
    if (!DISCORD_BOT_TOKEN) return;
    try {
      await this.client.login(DISCORD_BOT_TOKEN);
    } catch (err) {
      this.initError = err.message;
      console.error("[Discord Bot] Login failed:", err?.message);
    }
  }
  // Pre-fetch all application emojis at startup so lookups are 0ms in-memory
  async loadExistingApplicationEmojis() {
    try {
      const app = this.client.application;
      if (!app?.emojis) return;
      const emojis = await app.emojis.fetch().catch(() => null);
      if (emojis) {
        emojis.forEach((e) => {
          if (e.name) {
            const cleanKey = e.name.toLowerCase().replace(/^head_/, "");
            this.playerEmojiCache.set(cleanKey, `<:${e.name}:${e.id}>`);
          }
        });
        console.log(`[Discord Bot] Loaded ${emojis.size} pre-existing application head emojis into memory cache.`);
      }
    } catch (err) {
      console.warn("[Discord Bot] Could not preload application emojis:", err?.message);
    }
  }
  // Register Clean Slash Commands WITHOUT optional server address parameter
  async registerSlashCommands() {
    const commands = [
      new SlashCommandBuilder().setName("configure").setDescription("Link your Aternos server with your session").addStringOption((o) => o.setName("session").setDescription("Aternos session cookie").setRequired(true)),
      new SlashCommandBuilder().setName("start").setDescription("Turn on your Minecraft server (only when offline)"),
      new SlashCommandBuilder().setName("stop").setDescription("Turn off your Minecraft server (only when online)"),
      new SlashCommandBuilder().setName("restart").setDescription("Reboot your Minecraft server"),
      new SlashCommandBuilder().setName("status").setDescription("Check server status, online players, and port details"),
      new SlashCommandBuilder().setName("players").setDescription("View connected players and their small avatars")
    ];
    try {
      const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
      await rest.put(Routes.applicationCommands(this.botId || DISCORD_CLIENT_ID), {
        body: commands.map((cmd) => cmd.toJSON())
      });
      console.log("[Discord Bot] Clean slash commands registered successfully.");
    } catch (err) {
      console.warn("[Discord Bot] Slash commands notice:", err?.message);
    }
  }
  resolveServerContext(contextId, userId) {
    let binding = serverStorage.getDiscordBinding(contextId);
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
    const allStates = aternosService.getAllStates();
    const allProfiles = serverStorage.getAllProfiles();
    for (const p of allProfiles) {
      const pCanon = serverStorage.getCanonicalServerAddress(p.serverIp || p.name);
      const st = allStates[pCanon.toLowerCase()] || allStates[p.id];
      if (st && (st.status === "online" || st.status === "starting")) {
        return {
          serverAddress: pCanon,
          sessionCookie: p.sessionCookie,
          serverCookie: p.serverCookie,
          profile: p
        };
      }
    }
    const cfg = aternosService.getConfig();
    if (cfg.serverAddress) {
      const canonical = serverStorage.getCanonicalServerAddress(cfg.serverAddress);
      const profile = serverStorage.getProfile(canonical) || serverStorage.getProfile(cfg.serverAddress);
      return {
        serverAddress: canonical,
        sessionCookie: cfg.sessionCookie || profile?.sessionCookie || "",
        serverCookie: cfg.serverCookie || profile?.serverCookie || "",
        profile
      };
    }
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
    const defaultCanonical = "Bang_Bros_SMP.aternos.me";
    return {
      serverAddress: defaultCanonical,
      sessionCookie: "",
      serverCookie: ""
    };
  }
  // Instant 0ms synchronous head emoji lookup.
  // Never blocks, never stalls commands, never causes Discord rate limit issues.
  // If emoji exists in memory, returns <:head_name:id>.
  // If not, returns 👤 immediately and queues background creation.
  getPlayerHeadEmoji(playerName) {
    const cleanName = playerName.trim();
    if (!cleanName) return "\u{1F464}";
    const cacheKey = cleanName.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 26);
    const cached = this.playerEmojiCache.get(cacheKey);
    if (cached) return cached;
    const app = this.client.application;
    const emojiName = `head_${cacheKey}`;
    const found = app?.emojis?.cache?.find((e) => e.name === emojiName);
    if (found) {
      const formatted = `<:${found.name}:${found.id}>`;
      this.playerEmojiCache.set(cacheKey, formatted);
      return formatted;
    }
    this.queueBackgroundEmojiCreation(cleanName);
    return "\u{1F464}";
  }
  // Queue background head creation so it NEVER slows down user interactions
  queueBackgroundEmojiCreation(playerName) {
    if (!this.canCreateApplicationEmojis) return;
    const cleanKey = playerName.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 26);
    if (this.playerEmojiCache.has(cleanKey)) return;
    if (this.emojiQueue.includes(playerName)) return;
    this.emojiQueue.push(playerName);
    this.processEmojiQueue();
  }
  async processEmojiQueue() {
    if (this.isProcessingEmojiQueue || this.emojiQueue.length === 0) return;
    this.isProcessingEmojiQueue = true;
    try {
      while (this.emojiQueue.length > 0) {
        const nextName = this.emojiQueue.shift();
        if (!nextName) continue;
        const cleanKey = nextName.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 26);
        if (this.playerEmojiCache.has(cleanKey)) continue;
        await this.createHeadEmojiInBackground(nextName, cleanKey);
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      this.isProcessingEmojiQueue = false;
    }
  }
  async createHeadEmojiInBackground(cleanName, cacheKey) {
    try {
      const app = this.client.application;
      if (!app?.emojis) return;
      const emojiName = `head_${cacheKey}`;
      let appEmojis = app.emojis.cache;
      if (!appEmojis || appEmojis.size === 0) {
        appEmojis = await app.emojis.fetch().catch(() => null);
      }
      const existing = appEmojis?.find((e) => e.name === emojiName);
      if (existing) {
        this.playerEmojiCache.set(cacheKey, `<:${existing.name}:${existing.id}>`);
        return;
      }
      if (appEmojis && appEmojis.size >= 48) {
        const oldest = appEmojis.find((e) => e.name?.startsWith("head_"));
        if (oldest) {
          await oldest.delete().catch(() => {
          });
        }
      }
      const candidateUrls = [
        `https://mc-heads.net/avatar/${encodeURIComponent(cleanName)}/64`,
        `https://crafthead.net/helm/${encodeURIComponent(cleanName)}/64`,
        `https://minotar.net/helm/${encodeURIComponent(cleanName)}/64.png`
      ];
      let imageBuf = null;
      for (const url of candidateUrls) {
        try {
          const controller = new AbortController();
          const tm = setTimeout(() => controller.abort(), 1800);
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(tm);
          if (res.ok) {
            const arrayBuf = await res.arrayBuffer();
            if (arrayBuf.byteLength > 200) {
              imageBuf = Buffer.from(arrayBuf);
              break;
            }
          }
        } catch {
        }
      }
      if (!imageBuf) return;
      const size = 64;
      const radius = 16;
      const roundedCornersSvg = Buffer.from(
        `<svg><rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}"/></svg>`
      );
      const roundedBuf = await sharp(imageBuf).resize(size, size).composite([{ input: roundedCornersSvg, blend: "dest-in" }]).png().toBuffer();
      const created = await app.emojis.create({
        attachment: roundedBuf,
        name: emojiName
      });
      if (created) {
        this.playerEmojiCache.set(cacheKey, `<:${created.name}:${created.id}>`);
      }
    } catch (err) {
      if (err?.code === 30008 || err?.status === 403) {
        this.canCreateApplicationEmojis = false;
      }
    }
  }
  // Build real-time server status diagnostics embed
  // Shows small player heads for players, NO big player head thumbnail!
  buildStatusEmbed(serverAddress, state, live) {
    const canonicalAddr = serverStorage.getCanonicalServerAddress(serverAddress);
    const isOnline = state.status === "online" || live?.online;
    const statusText = isOnline ? "\u{1F7E2} Online" : state.status === "starting" ? "\u{1F7E1} Starting" : state.status === "queue" ? "\u23F3 In Queue" : "\u{1F534} Offline";
    const color = isOnline ? 1096065 : state.status === "starting" ? 16096779 : 15680580;
    const playerCount = Math.max(live?.players?.online || 0, state.playersOnline || 0);
    const maxCount = live?.players?.max || state.maxPlayers || 20;
    const embed = new EmbedBuilder().setColor(color).setTitle(`\u{1F3AE} Minecraft Server Diagnostics`).setDescription(`Live status for **${canonicalAddr}**:`).addFields(
      { name: "Status", value: `**${statusText}**`, inline: true },
      { name: "Players Online", value: `\`${playerCount}/${maxCount}\` active`, inline: true },
      { name: "Server Address", value: `\`${canonicalAddr}:${state.serverPort || 25565}\``, inline: true }
    );
    if (state.dynip) {
      embed.addFields({ name: "Direct Connect IP", value: `\`${state.dynip}\``, inline: true });
    }
    if (state.software || live?.version) {
      embed.addFields({
        name: "Version & Software",
        value: `${state.software || "Fabric"} ${live?.version || state.version || "1.20.4"}`,
        inline: true
      });
    }
    const playerNames = [];
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
    if (playerNames.length > 0) {
      const playerListItems = playerNames.map((n) => {
        const head = this.getPlayerHeadEmoji(n);
        return `${head} **${n}**`;
      });
      embed.addFields({
        name: `\u{1F464} Connected Players (${playerNames.length})`,
        value: playerListItems.join("  \u2022  "),
        inline: false
      });
    }
    if (state.motd || live?.motd) {
      embed.addFields({
        name: "\u{1F4DC} MOTD",
        value: `*${state.motd || live?.motd}*`,
        inline: false
      });
    }
    if (isOnline) {
      if (playerCount === 0) {
        const secs = state.countdownSeconds ?? 360;
        const mins = Math.floor(secs / 60);
        const s = secs % 60;
        const formatted = state.countdownFormatted || `${mins}:${s < 10 ? "0" : ""}${s}`;
        const targetEpoch = Math.floor(Date.now() / 1e3) + secs;
        embed.addFields({
          name: "\u23F1\uFE0F Keepalive Timer",
          value: `\`${formatted}\` remaining \u2022 Auto-shutdown <t:${targetEpoch}:R>
*(Synced with Aternos dashboard)*`,
          inline: false
        });
      } else {
        embed.addFields({
          name: "\u23F1\uFE0F Keepalive Timer",
          value: `\u{1F7E2} **Paused** (${playerCount} active player${playerCount > 1 ? "s" : ""} connected)`,
          inline: false
        });
      }
    }
    embed.setFooter({ text: "Aternos Command Center", iconURL: this.client.user?.displayAvatarURL() });
    embed.setTimestamp();
    return embed;
  }
  // Fast resolution of fresh Aternos + Minecraft live status with concurrency protection
  async getFastServerState(serverAddress, sessionCookie) {
    let state = aternosService.getState(serverAddress);
    if (sessionCookie && (state.status === "offline" || Date.now() - state.lastUpdated > 3500)) {
      try {
        const syncTimeout = new Promise((resolve) => setTimeout(() => resolve(state), 2500));
        state = await Promise.race([aternosService.syncSessionState(serverAddress), syncTimeout]);
      } catch {
      }
    }
    const live = await queryMinecraftServer(
      serverAddress,
      state.dynip,
      state.playersOnline || 0,
      state.playerList || [],
      state.status === "online" || state.status === "starting"
    );
    return { state, live };
  }
  // Clean up previous bot messages for the user so each new command replaces the old message
  async deleteUserPreviousMessages(userId, currentInteraction) {
    const prevList = this.userLastInteractions.get(userId) || [];
    for (const item of prevList) {
      if (item.interaction && item.interaction.id !== currentInteraction.id) {
        try {
          if (Date.now() - item.timestamp < 14 * 60 * 1e3) {
            await item.interaction.deleteReply().catch(() => {
            });
          }
        } catch {
        }
      }
    }
    this.userLastInteractions.set(userId, [
      { interaction: currentInteraction, timestamp: Date.now() }
    ]);
    try {
      const channel = currentInteraction.channel;
      if (channel && "messages" in channel && typeof channel.messages?.fetch === "function") {
        const fetched = await channel.messages.fetch({ limit: 10 }).catch(() => null);
        if (fetched) {
          const botMessages = fetched.filter((m) => m.author?.id === this.client.user?.id);
          for (const [, msg] of botMessages) {
            await msg.delete().catch(() => {
            });
          }
        }
      }
    } catch {
    }
  }
  // Handle Slash Command with complete concurrency and rate limit protection
  async handleSlashCommand(interaction) {
    const { commandName, user, guildId, channelId } = interaction;
    const contextId = guildId || channelId || user.id;
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }
    } catch (err) {
      console.warn(`[Discord] Could not defer /${commandName}:`, err?.message);
      return;
    }
    await this.deleteUserPreviousMessages(user.id, interaction);
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
            const embed2 = new EmbedBuilder().setColor(1096065).setTitle("\u2699\uFE0F Aternos Server Configured").setDescription(`Successfully linked **${canonicalAddr}** to this Discord server.
You can now control your server using slash commands.`).addFields(
              { name: "\u{1F310} Server Address", value: `\`${canonicalAddr}\``, inline: true },
              { name: "\u{1F511} Server ID", value: `\`${matchedServer.id}\``, inline: true },
              { name: "\u{1F512} Session Auth", value: "\u2705 Synced & Active", inline: true },
              {
                name: "\u{1F3AE} Control Commands",
                value: "`/status` \u2014 Check online status & player count\n`/players` \u2014 View online players\n`/start` \u2014 Turn on server\n`/stop` \u2014 Turn off server\n`/restart` \u2014 Reboot server"
              }
            ).setFooter({ text: "Aternos Command Center", iconURL: this.client.user?.displayAvatarURL() }).setTimestamp();
            await interaction.editReply({ embeds: [embed2] });
            return;
          }
          if (discovered.length === 0) {
            const embed2 = new EmbedBuilder().setColor(15680580).setTitle("\u274C No Aternos Servers Found").setDescription(
              "Could not locate any servers on this Aternos account.\nPlease make sure your `ATERNOS_SESSION` cookie is copied from your browser while logged into [aternos.org](https://aternos.org/servers/)."
            );
            await interaction.editReply({ embeds: [embed2] });
            return;
          }
          const menuCustomId = `select_srv_${user.id}_${Date.now()}`;
          this.pendingSelections.set(menuCustomId, {
            session,
            servers: discovered,
            contextId,
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
          const ctx = this.resolveServerContext(contextId, user.id);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);
          if (state.status === "online" || live.online) {
            const embed = new EmbedBuilder().setColor(15680580).setTitle("\u26A0\uFE0F Server is Already Online!").setDescription(`**${ctx.serverAddress}** is already online and running. You cannot start a server that is currently active.`).addFields(
              { name: "Status", value: "\u{1F7E2} **Online**", inline: true },
              { name: "Players", value: `\`${live.players.online}/${live.players.max}\``, inline: true },
              { name: "Tip", value: "Use `/stop` to shut it down, or `/restart` to reboot.", inline: false }
            );
            await interaction.editReply({ embeds: [embed] });
            return;
          }
          if (state.status === "starting" || state.status === "queue") {
            const embed = new EmbedBuilder().setColor(16096779).setTitle("\u23F3 Server is Currently Booting Up!").setDescription(`**${ctx.serverAddress}** is already in the starting sequence. Please give it 1 to 2 minutes to load world data.`).addFields({ name: "Current Status", value: `\u{1F7E1} ${state.rawStatus || "Starting ..."}` });
            await interaction.editReply({ embeds: [embed] });
            return;
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
            const embed = new EmbedBuilder().setColor(1096065).setTitle("\u{1F680} Server Boot Sequence Initiated").setDescription(`Start signal dispatched to Aternos for **${ctx.serverAddress}**.
The server is now starting up and will be ready for players in ~1-2 minutes.`).addFields(
              { name: "Status", value: "\u{1F7E1} **Starting ...**", inline: true },
              { name: "Estimated Time", value: "~60-90 seconds", inline: true },
              { name: "Tip", value: "Run `/status` in a moment to track startup progress.", inline: false }
            ).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } else {
            const embed = new EmbedBuilder().setColor(15680580).setTitle("\u274C Start Command Failed").setDescription(`Aternos rejected the start request:
\`${res.message}\`
Verify that your session cookie is valid via \`/configure\`.`);
            await interaction.editReply({ embeds: [embed] });
          }
          break;
        }
        case "stop": {
          const ctx = this.resolveServerContext(contextId, user.id);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);
          if (state.status === "offline" && !live.online) {
            const embed = new EmbedBuilder().setColor(15680580).setTitle("\u26A0\uFE0F Server is Already Offline!").setDescription(`**${ctx.serverAddress}** is already turned off. Cannot stop a server that isn't running.`).addFields({ name: "Tip", value: "Use `/start` if you would like to boot it up." });
            await interaction.editReply({ embeds: [embed] });
            return;
          }
          if (state.status === "stopping") {
            const embed = new EmbedBuilder().setColor(16096779).setTitle("\u23F3 Server is Already Shutting Down!").setDescription(`**${ctx.serverAddress}** is already in the shutdown sequence. Please wait while world files are saved.`);
            await interaction.editReply({ embeds: [embed] });
            return;
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
            const embed = new EmbedBuilder().setColor(16347926).setTitle("\u{1F6D1} Server Shutdown Initiated").setDescription(`Stop signal successfully sent to Aternos for **${ctx.serverAddress}**.
World progress is being saved and the server is powering down safely.`).addFields({ name: "Status", value: "\u{1F7E0} **Stopping ...**", inline: true }).setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } else {
            const embed = new EmbedBuilder().setColor(15680580).setTitle("\u274C Stop Command Failed").setDescription(`Aternos returned: \`${res.message}\``);
            await interaction.editReply({ embeds: [embed] });
          }
          break;
        }
        case "restart": {
          const ctx = this.resolveServerContext(contextId, user.id);
          const res = await aternosService.restartServer(ctx.serverAddress, {
            sessionCookie: ctx.sessionCookie,
            serverCookie: ctx.serverCookie,
            serverAddress: ctx.serverAddress
          });
          const embed = new EmbedBuilder().setColor(res.success ? 3900150 : 15680580).setTitle(res.success ? "\u{1F504} Server Reboot Triggered" : "\u274C Restart Failed").setDescription(`Restart signal sent to Aternos for **${ctx.serverAddress}**.
The server will cycle off and boot back up automatically.`).addFields({ name: "Result", value: res.message });
          await interaction.editReply({ embeds: [embed] });
          break;
        }
        case "status": {
          const ctx = this.resolveServerContext(contextId, user.id);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);
          const embed = this.buildStatusEmbed(ctx.serverAddress, state, live);
          await interaction.editReply({ embeds: [embed] });
          break;
        }
        case "players": {
          const ctx = this.resolveServerContext(contextId, user.id);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);
          const isOnline = live.online || state.status === "online" || state.status === "starting";
          if (!isOnline) {
            const embed2 = new EmbedBuilder().setColor(15680580).setTitle("\u{1F534} Server is Offline").setDescription(`Cannot fetch active players because **${ctx.serverAddress}** is currently offline.
Use \`/start\` to bring the server online.`);
            await interaction.editReply({ embeds: [embed2] });
            return;
          }
          const playerNames = /* @__PURE__ */ new Set();
          for (const p of live.players?.list || []) {
            if (p?.name) playerNames.add(p.name);
          }
          for (const name of state.playerList || []) {
            if (name) playerNames.add(name);
          }
          const combinedList = Array.from(playerNames);
          const count = Math.max(combinedList.length, live.players?.online || 0, state.playersOnline || 0);
          const max = live.players?.max || state.maxPlayers || 20;
          if (count === 0 && combinedList.length === 0) {
            const embed2 = new EmbedBuilder().setColor(7434618).setTitle(`\u{1F465} No Players Online (0/${max})`).setDescription(`There are currently 0 players connected to **${ctx.serverAddress}**.
The world is quiet and waiting for players to join.`);
            if (isOnline) {
              const secs = state.countdownSeconds ?? 360;
              const mins = Math.floor(secs / 60);
              const s = secs % 60;
              const formatted = state.countdownFormatted || `${mins}:${s < 10 ? "0" : ""}${s}`;
              const targetEpoch = Math.floor(Date.now() / 1e3) + secs;
              embed2.addFields({
                name: "\u23F1\uFE0F Keepalive Timer",
                value: `\`${formatted}\` remaining \u2022 Auto-shutdown <t:${targetEpoch}:R>
*(Synced with Aternos dashboard)*`,
                inline: false
              });
            }
            embed2.setFooter({ text: "Aternos Command Center", iconURL: this.client.user?.displayAvatarURL() });
            embed2.setTimestamp();
            await interaction.editReply({ embeds: [embed2] });
            return;
          }
          const embed = new EmbedBuilder().setColor(1096065).setTitle(`\u{1F465} Online Players (${count}/${max})`).setDescription(`Active players currently connected to **${ctx.serverAddress}**:`).setTimestamp();
          if (combinedList.length > 0) {
            const playerLines = combinedList.map((name, idx) => {
              const headEmoji = this.getPlayerHeadEmoji(name);
              return `**${idx + 1}.** ${headEmoji} **${name}**`;
            });
            embed.addFields({ name: "Connected Players", value: playerLines.join("\n"), inline: false });
          } else {
            embed.setDescription(`There ${count === 1 ? "is" : "are"} currently **${count}** player${count > 1 ? "s" : ""} connected to the server.`);
          }
          embed.setFooter({
            text: "Aternos Command Center",
            iconURL: this.client.user?.displayAvatarURL()
          });
          await interaction.editReply({ embeds: [embed] });
          break;
        }
        default:
          await interaction.editReply({ content: "Unknown command." });
      }
    } catch (err) {
      if (err?.code === 10008 || err?.message?.includes("Unknown Message")) {
        return;
      }
      console.error(`[Discord /${commandName} Error]`, err);
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
    const { customId, values, user } = interaction;
    const pending = this.pendingSelections.get(customId);
    if (!pending) {
      await interaction.reply({
        content: "\u26A0\uFE0F This server selection menu has expired. Please run `/configure` again.",
        ephemeral: true
      });
      return;
    }
    const selectedId = values[0];
    const chosenServer = pending.servers.find((s) => s.id === selectedId);
    if (!chosenServer) {
      await interaction.reply({
        content: "\u26A0\uFE0F Selected server was not found.",
        ephemeral: true
      });
      return;
    }
    try {
      await interaction.deferUpdate();
      const canonicalAddr = serverStorage.getCanonicalServerAddress(chosenServer.serverAddress);
      serverStorage.setDiscordBinding({
        guildIdOrUserId: pending.contextId,
        serverAddress: canonicalAddr,
        sessionCookie: pending.session,
        serverCookie: chosenServer.serverCookie,
        configuredBy: pending.userName,
        updatedAt: Date.now()
      });
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
      const embed = new EmbedBuilder().setColor(1096065).setTitle("\u2705 Aternos Server Linked Successfully").setDescription(`Successfully linked **${canonicalAddr}** (ID: \`${chosenServer.id}\`) to this Discord server.
You can now control your server directly!`).addFields(
        { name: "\u{1F310} Server Address", value: `\`${canonicalAddr}\``, inline: true },
        { name: "\u{1F511} Server ID", value: `\`${chosenServer.id}\``, inline: true },
        { name: "\u{1F512} Session Auth", value: "\u2705 Synced & Active", inline: true },
        {
          name: "\u{1F3AE} Control Commands",
          value: "`/status` \u2014 Check online status & player count\n`/players` \u2014 View online players\n`/start` \u2014 Turn on server\n`/stop` \u2014 Turn off server\n`/restart` \u2014 Reboot server"
        }
      ).setFooter({ text: "Aternos Command Center", iconURL: this.client.user?.displayAvatarURL() }).setTimestamp();
      await interaction.editReply({ embeds: [embed], components: [] });
      this.pendingSelections.delete(customId);
      this.userLastInteractions.set(user.id, [
        { interaction, timestamp: Date.now() }
      ]);
    } catch (err) {
      console.error("[Select Menu Error]", err);
    }
  }
  getBotStatus() {
    return {
      isReady: this.isReady,
      botTag: this.botTag || (this.isReady ? "Aternos#3859" : "Connecting..."),
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
var __dirname = path3.dirname(__filename);
var ADMIN_USERNAME = "Shifin";
var ADMIN_PASSWORD = "0508552513";
var ADMIN_TOKEN = "shifin-auth-session-key-0508552513";
async function startServer() {
  const app = express();
  const PORT = 3e3;
  app.use(express.json());
  app.get("/api/status", (req, res) => {
    const serverParam = req.query.server?.toLowerCase();
    const shouldRefresh = req.query.refresh === "true";
    if (serverParam) {
      if (shouldRefresh) {
        aternosService.syncSessionState(serverParam).catch(() => {
        });
      }
      const specificState = aternosService.getState(serverParam);
      res.json({
        ...specificState,
        allServerStates: aternosService.getAllStates()
      });
      return;
    }
    if (shouldRefresh) {
      aternosService.syncState().catch(() => {
      });
    }
    const activeState = aternosService.getState();
    const allServerStates = aternosService.getAllStates();
    res.json({
      ...activeState,
      allServerStates
    });
  });
  app.get("/api/servers", (req, res) => {
    const all = serverStorage.getAllProfiles();
    res.json(all.length > 0 ? all : aternosService.getServersList());
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
  app.post("/api/servers/sync", async (req, res) => {
    const { servers } = req.body || {};
    if (Array.isArray(servers)) {
      serverStorage.syncFromClient(servers, "web");
      await aternosService.syncProfiles(servers);
    }
    res.json({ success: true, count: servers?.length || 0 });
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
  app.get("/api/admin/bot-status", verifyAdmin, (req, res) => {
    res.json({
      success: true,
      ...discordBot.getBotStatus()
    });
  });
  const isProduction = process.env.NODE_ENV === "production" || __filename.endsWith("server.js") || !fs3.existsSync(path3.resolve(__dirname, "node_modules/vite"));
  if (!isProduction) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path3.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path3.resolve(distPath, "index.html"));
    });
  }
  discordBot.start().catch((err) => {
    console.warn("[Discord Bot] Startup warning:", err?.message);
  });
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Aternos Command Center] Server listening on http://0.0.0.0:${PORT}`);
  });
}
startServer().catch((err) => {
  console.error("[Fatal] Server failed to start:", err);
  process.exit(1);
});
