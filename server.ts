import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { aternosService } from './src/server/aternosAutomation.ts';
import { discordBot } from './src/server/discordBot.ts';
import { serverStorage } from './src/server/serverStorage.ts';
import { CURRENT_ENV, DATA_PREFIX, getRedisHealth } from './src/server/redisClient.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADMIN_USERNAME = 'Shifin';
const ADMIN_PASSWORD = '0508552513';
const ADMIN_TOKEN = 'shifin-auth-session-key-0508552513';

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(express.json());

  // API Endpoints - Status
  app.get('/api/status', (req, res) => {
    const serverParam = (req.query.server as string)?.toLowerCase();
    const shouldRefresh = req.query.refresh === 'true';
    const token = req.headers['x-admin-token'] || req.query.admin_token;
    const isAdmin = token === ADMIN_TOKEN;

    if (serverParam) {
      if (shouldRefresh) {
        aternosService.syncSessionState(serverParam).catch(() => {});
      }
      const specificState = aternosService.getState(serverParam);
      res.json({
        ...specificState,
        allServerStates: isAdmin ? aternosService.getAllStates() : { [serverParam]: specificState },
      });
      return;
    }

    if (shouldRefresh) {
      aternosService.syncState().catch(() => {});
    }

    const activeState = aternosService.getState();
    res.json({
      ...activeState,
      allServerStates: isAdmin ? aternosService.getAllStates() : {},
    });
  });

  // Server list: only authenticated admin receives shared profiles; new/public users receive empty
  app.get('/api/servers', (req, res) => {
    const token = req.headers['x-admin-token'] || req.query.admin_token;
    if (token === ADMIN_TOKEN) {
      const all = serverStorage.getAllProfiles();
      res.json(all);
    } else {
      res.json([]);
    }
  });

  app.get('/api/servers/status', (req, res) => {
    res.json(aternosService.getAllStates());
  });

  app.get('/api/logs', (req, res) => {
    res.json(aternosService.getLogs());
  });

  app.delete('/api/logs', (req, res) => {
    aternosService.clearLogs();
    res.json({ success: true, message: 'Logs cleared.' });
  });

  // Server Actions
  app.post('/api/action/start', async (req, res) => {
    const { serverAddress, sessionCookie, serverCookie, serverId } = req.body || {};
    const result = await aternosService.startServer(serverAddress, {
      sessionCookie,
      serverCookie,
      serverAddress,
      serverId,
    });
    res.json(result);
  });

  app.post('/api/action/stop', async (req, res) => {
    const { serverAddress, sessionCookie, serverCookie, serverId } = req.body || {};
    const result = await aternosService.stopServer(serverAddress, {
      sessionCookie,
      serverCookie,
      serverAddress,
      serverId,
    });
    res.json(result);
  });

  app.post('/api/action/restart', async (req, res) => {
    const { serverAddress, sessionCookie, serverCookie, serverId } = req.body || {};
    const result = await aternosService.restartServer(serverAddress, {
      sessionCookie,
      serverCookie,
      serverAddress,
      serverId,
    });
    res.json(result);
  });

  app.post('/api/action/extend', async (req, res) => {
    const { serverAddress, sessionCookie, serverCookie, serverId } = req.body || {};
    const result = await aternosService.extendTimer(serverAddress, {
      sessionCookie,
      serverCookie,
      serverAddress,
      serverId,
    });
    res.json(result);
  });

  app.post('/api/action/test-start', async (req, res) => {
    const result = await aternosService.runSelfTest();
    res.json(result);
  });

  app.get('/api/macros', (req, res) => {
    const serverParam = req.query.server as string;
    res.json(aternosService.getMacros(serverParam));
  });

  app.post('/api/macros', (req, res) => {
    const { rules, serverAddress, serverId } = req.body || {};
    const target = (req.query.server as string) || serverAddress || serverId;
    const updated = aternosService.updateMacros(rules, target);
    res.json(updated);
  });

  app.post('/api/macros/trigger/:id', async (req, res) => {
    const { serverAddress, serverId } = req.body || {};
    const target = (req.query.server as string) || serverAddress || serverId;
    const result = await aternosService.triggerMacro(req.params.id, target);
    res.json(result);
  });

  app.post('/api/action/command', async (req, res) => {
    const { command } = req.body || {};
    const result = await aternosService.executeCliCommand(command || '');
    res.json(result);
  });

  app.get('/api/config', (req, res) => {
    res.json(aternosService.getConfig());
  });

  app.post('/api/config', async (req, res) => {
    const { sessionCookie, serverCookie, serverAddress, cfClearanceCookie, userAgent, software, version, serverPort } = req.body || {};
    await aternosService.updateConfig({ sessionCookie, serverCookie, serverAddress, cfClearanceCookie, userAgent, software, version, serverPort });
    if (serverAddress) {
      serverStorage.saveProfile({
        id: `srv-${serverAddress.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`,
        name: serverAddress,
        serverIp: serverAddress,
        serverPort: serverPort || '25565',
        software: software || 'Fabric',
        version: version || '1.20.4',
        sessionCookie: sessionCookie || '',
        serverCookie: serverCookie || '',
        source: 'web',
      });
    }
    res.json({ success: true, message: 'Settings updated successfully.' });
  });

  app.get('/api/system/info', async (req, res) => {
    const redisHealth = await getRedisHealth();
    res.json({
      name: 'Apexion',
      environment: CURRENT_ENV,
      storageNamespace: DATA_PREFIX,
      redisHealth,
      botStatus: discordBot.getBotStatus(),
      uptime: process.uptime(),
    });
  });

  app.post('/api/servers/sync', async (req, res) => {
    const { servers } = req.body || {};
    if (Array.isArray(servers)) {
      serverStorage.syncFromClient(servers, 'web');
      await aternosService.syncProfiles(servers);
    }
    res.json({ success: true, count: servers?.length || 0 });
  });

  app.post('/api/user/sync', async (req, res) => {
    const { servers } = req.body || {};
    if (Array.isArray(servers)) {
      serverStorage.syncFromClient(servers, 'web');
      await aternosService.syncProfiles(servers);
    }
    res.json({ success: true, count: servers?.length || 0 });
  });

  app.get('/api/user/profiles', (req, res) => {
    const token = req.headers['x-admin-token'] || req.query.admin_token;
    if (token === ADMIN_TOKEN) {
      const all = serverStorage.getAllProfiles();
      res.json({ success: true, servers: all });
    } else {
      res.json({ success: true, servers: [] });
    }
  });

  app.post('/api/server/detect', async (req, res) => {
    const ac = new AbortController();
    req.on('close', () => {
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
    } catch (err: any) {
      if (!res.writableEnded) {
        res.status(500).json({ success: false, message: err?.message || 'Detect error' });
      }
    }
  });

  // ================= ADMIN AUTH & CONTROL ENDPOINTS =================
  app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    const cleanUser = String(username || '').trim();
    const cleanPass = String(password || '').trim();

    if (
      cleanUser.toLowerCase() === ADMIN_USERNAME.toLowerCase() &&
      cleanPass === ADMIN_PASSWORD
    ) {
      res.json({
        success: true,
        token: ADMIN_TOKEN,
        username: ADMIN_USERNAME,
        message: 'Administrator authentication verified.',
      });
    } else {
      res.status(401).json({
        success: false,
        message: 'Invalid credentials. Access denied.',
      });
    }
  });

  // Admin Middleware helper
  const verifyAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = req.headers['x-admin-token'] || req.query.admin_token;
    if (token === ADMIN_TOKEN) {
      next();
    } else {
      res.status(403).json({ success: false, message: 'Unauthorized. Admin credentials required.' });
    }
  };

  // Get all server profiles across all users and discord
  app.get('/api/admin/servers', verifyAdmin, (req, res) => {
    const profiles = serverStorage.getAllProfiles();
    const liveStates = aternosService.getAllStates();
    const enriched = profiles.map(p => {
      const key = (p.serverIp || p.name || p.id).toLowerCase();
      const st = liveStates[key] || liveStates[p.id];
      return {
        ...p,
        liveStatus: st?.status || 'unknown',
        rawStatus: st?.rawStatus || 'Unknown',
        countdownFormatted: st?.countdownFormatted,
        playersOnline: st?.playersOnline,
        playerList: st?.playerList || [],
        maxPlayers: st?.maxPlayers,
        dynip: st?.dynip,
      };
    });
    res.json({
      success: true,
      totalCount: enriched.length,
      servers: enriched,
    });
  });

  // Admin save/edit server profile
  app.post('/api/admin/servers/save', verifyAdmin, (req, res) => {
    const { profile } = req.body || {};
    if (!profile) {
      res.status(400).json({ success: false, message: 'Profile data missing.' });
      return;
    }
    const saved = serverStorage.saveProfile({
      ...profile,
      source: profile.source || 'admin',
    });
    res.json({ success: true, profile: saved });
  });

  // Admin delete server profile
  app.delete('/api/admin/servers/:id', verifyAdmin, (req, res) => {
    const { id } = req.params;
    const deleted = serverStorage.deleteProfile(id);
    res.json({ success: deleted, message: deleted ? 'Profile deleted.' : 'Profile not found.' });
  });

  // Admin execute action on any server
  app.post('/api/admin/servers/action', verifyAdmin, async (req, res) => {
    const { action, serverAddress, sessionCookie, serverCookie, serverId } = req.body || {};
    let result: any = { success: false, message: 'Unknown action' };

    const creds = { sessionCookie, serverCookie, serverAddress, serverId };

    if (action === 'start') {
      result = await aternosService.startServer(serverAddress, creds);
    } else if (action === 'stop') {
      result = await aternosService.stopServer(serverAddress, creds);
    } else if (action === 'restart') {
      result = await aternosService.restartServer(serverAddress, creds);
    } else if (action === 'extend') {
      result = await aternosService.extendTimer(serverAddress, creds);
    }

    res.json(result);
  });

  // Admin Discord bot status & logs
  app.get('/api/admin/bot-status', verifyAdmin, async (req, res) => {
    const redisHealth = await getRedisHealth();
    res.json({
      success: true,
      redisHealth,
      ...discordBot.getBotStatus(),
    });
  });

  // Admin Discord bot mode switch (dev vs published)
  app.get('/api/admin/bot-mode', verifyAdmin, (req, res) => {
    res.json({
      success: true,
      activeTarget: serverStorage.getBotTarget(),
      currentEnv: discordBot.getBotStatus().currentEnv,
      isBotRunning: discordBot.getBotStatus().isReady,
      botTag: discordBot.getBotStatus().botTag,
    });
  });

  app.post('/api/admin/bot-mode', verifyAdmin, async (req, res) => {
    const { target } = req.body || {};
    if (target !== 'dev' && target !== 'published' && target !== 'disabled') {
      res.status(400).json({ success: false, message: 'Invalid target. Must be "dev", "published", or "disabled".' });
      return;
    }

    await discordBot.setTargetMode(target);

    res.json({
      success: true,
      message: `Discord bot target globally set to "${target.toUpperCase()}" via Upstash Redis.`,
      activeTarget: target,
      currentEnv: discordBot.getBotStatus().currentEnv,
      isBotRunning: discordBot.getBotStatus().isReady,
    });
  });

  // Vite Integration
  const isProduction = process.env.NODE_ENV === 'production' || __filename.endsWith('server.js') || !fs.existsSync(path.resolve(__dirname, 'node_modules/vite'));

  if (!isProduction) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  // Start Discord Bot ONLY in published/production environment!
  // In dev/preview, the bot is kept completely OFF to prevent duplicate connections or clashing with the published bot
  if (CURRENT_ENV === 'published') {
    discordBot.start().catch(err => {
      console.warn('[Apexion Bot] Startup notice:', err?.message);
    });
  } else {
    console.log('[Apexion Bot] Preview dev server: Discord bot is TURNED OFF to prevent interference with published bot.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Apexion] Server listening on http://0.0.0.0:${PORT} [${CURRENT_ENV.toUpperCase()}]`);

    // Self-keepalive ping every 25 seconds to keep Cloud Run container active and prevent Discord WebSocket drops
    setInterval(() => {
      fetch(`http://127.0.0.1:${PORT}/api/servers/status`).catch(() => {});
    }, 25000);
  });
}

startServer().catch(err => {
  console.error('[Fatal] Server failed to start:', err);
  process.exit(1);
});
