import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { aternosService } from './aternosAutomation.ts';
import type { AternosState } from '../types/aternos.ts';
import { serverStorage } from './serverStorage.ts';
import { queryMinecraftServer, isAternosOfflineIndicator } from './mcPing.ts';
import { CURRENT_ENV, GLOBAL_KEYS, redis, getRedisJson, setRedisJson } from './redisClient.ts';

function getBotToken(): string {
  return serverStorage.getBotToken() || process.env.DISCORD_BOT_TOKEN || '';
}

function getBotClientId(): string {
  return serverStorage.getBotClientId() || process.env.DISCORD_CLIENT_ID || '1555330856757755994';
}

interface DiscoveredServer {
  id: string;
  name: string;
  serverAddress: string;
  serverCookie: string;
}

interface PendingSession {
  session: string;
  servers: DiscoveredServer[];
  contextId: string;
  guildId?: string;
  userId: string;
  userName: string;
}

export class DiscordBotService {
  private client: Client;
  private isReady: boolean = false;
  private botTag: string = '';
  private botId: string = '';
  private lastPing: number = 0;
  private initError: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isExplicitlyStopped: boolean = false;
  private leaderLeaseTime: number = 0;

  // Track the last message sent in each context to prevent channel clutter
  private lastChannelMessageIds: Map<string, string> = new Map();

  // Track the last interaction reply per user to delete their previous message
  private lastUserReplies: Map<string, ChatInputCommandInteraction> = new Map();

  // Player head emoji cache: playerName.toLowerCase() -> '<:head_name:id>'
  private playerEmojiCache: Map<string, string> = new Map();
  private pendingSelections: Map<string, PendingSession> = new Map();

  constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds],
      ws: {
        large_threshold: 50,
      },
      rest: {
        timeout: 15000,
        retries: 3,
      },
    });

    this.setupEventHandlers();
    this.startWatchdog();
  }

  private setupEventHandlers() {
    this.client.once('ready', async () => {
      this.isReady = true;
      this.botTag = this.client.user?.tag || 'Apexion Bot';
      this.botId = this.client.user?.id || getBotClientId();
      this.lastPing = this.client.ws.ping;
      console.log(`[Apexion Discord Bot (${CURRENT_ENV.toUpperCase()})] Connected as ${this.botTag} (${this.botId})`);

      serverStorage.addDiscordLog({
        user: this.botTag,
        command: 'READY',
        serverAddress: 'discord.gateway',
        status: 'success',
        message: `Connected in ${this.client.guilds.cache.size} server(s) [${CURRENT_ENV.toUpperCase()}]`,
      });

      // Preload emojis and register slash commands
      await this.loadExistingApplicationEmojis().catch(() => {});
      await this.registerSlashCommands().catch(() => {});
    });

    // Interaction handler
    this.client.on('interactionCreate', async interaction => {
      try {
        if (interaction.isChatInputCommand()) {
          this.handleSlashCommand(interaction).catch(err => {
            console.error('[Apexion Slash Command Error]', err);
          });
        } else if (interaction.isStringSelectMenu()) {
          this.handleSelectMenu(interaction).catch(err => {
            console.error('[Apexion Select Menu Error]', err);
          });
        }
      } catch (err: any) {
        console.error('[Apexion Interaction Event Error]', err);
      }
    });

    this.client.on('error', err => {
      console.error('[Apexion Bot Error]', err?.message);
      this.initError = err.message;
    });

    this.client.on('shardError', error => {
      console.warn('[Apexion Bot Shard Error]:', error?.message);
    });

    this.client.on('shardResume', shardId => {
      console.log(`[Apexion Bot] Gateway shard ${shardId} resumed session.`);
      this.isReady = true;
    });

    this.client.on('shardReconnecting', shardId => {
      console.log(`[Apexion Bot] Gateway shard ${shardId} reconnecting...`);
    });

    this.client.on('shardDisconnect', (event, shardId) => {
      console.warn(`[Apexion Bot Shard ${shardId} Disconnected] Code: ${event.code}`);
      this.isReady = false;
      this.scheduleReconnect();
    });
  }

  /**
   * Distributed leader & watchdog loop:
   * Keeps published bot online 24/7. In dev/preview, the bot is dormant and OFF to prevent collisions.
   */
  private startWatchdog() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(async () => {
      try {
        const globalTarget = await getRedisJson<string>(GLOBAL_KEYS.BOT_MODE, 'published');
        if (globalTarget === 'disabled') {
          if (this.isReady || this.client.isReady()) {
            console.log(`[Apexion Bot Watchdog] Bot is explicitly disabled by admin. Standing down.`);
            await this.stop().catch(() => {});
          }
          return;
        }

        const isPublishedInstance = CURRENT_ENV === 'published';
        const isDevInstance = CURRENT_ENV === 'dev';

        // Check if there is an active published leader heartbeat in Redis (within last 75s)
        const activeLeader = await getRedisJson<{ env: string; heartbeat: number } | null>(GLOBAL_KEYS.BOT_LEADER, null);
        const now = Date.now();
        const isPublishedActive = activeLeader && activeLeader.env === 'published' && (now - activeLeader.heartbeat < 75000);

        // Published always runs; dev runs if target is 'dev' OR if no published instance is actively leading
        const shouldRunHere = isPublishedInstance || globalTarget === 'dev' || !isPublishedActive;

        if (shouldRunHere) {
          const wsStatus = this.client.ws?.status; // 0 = READY in discord.js
          if ((!this.isReady || wsStatus !== 0) && !this.isExplicitlyStopped) {
            console.log(`[Apexion Bot Watchdog] Maintaining active bot connection on ${CURRENT_ENV}...`);
            await this.start().catch(() => {});
          }
          // Renew active lease in Upstash Redis (TTL 90s)
          await setRedisJson(GLOBAL_KEYS.BOT_LEADER, { env: CURRENT_ENV, heartbeat: Date.now() }, 90);
        } else {
          if (this.isReady || this.client.isReady()) {
            console.log(`[Apexion Bot Watchdog] Standing down ${CURRENT_ENV} as active published leader is operational.`);
            await this.stop().catch(() => {});
          }
        }
      } catch {}
    }, 30000);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!getBotToken()) return;

      const activeTarget = serverStorage.getBotTarget();
      if (activeTarget === 'disabled') return;

      this.isExplicitlyStopped = false;
      console.log(`[Apexion Bot (${CURRENT_ENV})] Reconnecting gateway...`);
      await this.start().catch(() => {});
    }, 2000);
  }

  public async start(): Promise<void> {
    const activeTarget = serverStorage.getBotTarget();
    if (activeTarget === 'disabled') {
      console.log(`[Apexion Bot] Bot is explicitly disabled by admin.`);
      this.isExplicitlyStopped = true;
      return;
    }

    const token = getBotToken();
    if (!token) {
      console.warn('[Apexion Bot] No token provided. Configure your Discord bot token in the Admin Panel.');
      return;
    }

    if (this.isReady && this.client.isReady() && this.client.ws?.status === 0) {
      return;
    }

    try {
      this.isExplicitlyStopped = false;
      this.initError = null;
      console.log(`[Apexion Bot (${CURRENT_ENV})] Connecting to Discord Gateway...`);
      await this.client.login(token);
    } catch (err: any) {
      this.initError = err.message;
      console.error(`[Apexion Bot (${CURRENT_ENV})] Login failed:`, err?.message);
      this.scheduleReconnect();
    }
  }

  public async stop(): Promise<void> {
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
        user: this.botTag || 'Apexion Bot',
        command: 'STANDBY',
        serverAddress: 'discord.gateway',
        status: 'warning',
        message: `Bot on standby in ${CURRENT_ENV}`,
      });
    } catch (err: any) {
      console.warn('[Apexion Bot] Error during stop:', err?.message);
    }
  }

  public async updateCredentials(token: string, clientId?: string): Promise<{ success: boolean; message: string; botTag?: string }> {
    const cleanToken = (token || '').trim();
    if (!cleanToken) {
      return { success: false, message: 'Bot token cannot be empty.' };
    }

    let cleanClientId = (clientId || '').trim();
    if (!cleanClientId && cleanToken.includes('.')) {
      try {
        const firstPart = cleanToken.split('.')[0];
        const decoded = Buffer.from(firstPart, 'base64').toString('ascii');
        if (/^\d{17,20}$/.test(decoded)) {
          cleanClientId = decoded;
        }
      } catch {}
    }

    await serverStorage.setBotCredentials(cleanToken, cleanClientId);

    try {
      this.isExplicitlyStopped = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      try {
        this.client.destroy();
      } catch {}

      this.client = new Client({
        intents: [GatewayIntentBits.Guilds],
        ws: { large_threshold: 50 },
        rest: { timeout: 15000, retries: 3 },
      });

      this.setupEventHandlers();
      this.isReady = false;
      this.initError = null;

      console.log(`[Apexion Bot] Authenticating with updated Discord bot token...`);
      await this.client.login(cleanToken);

      // Wait briefly up to 4s for ready event
      let waited = 0;
      while (!this.isReady && waited < 4000) {
        await new Promise(r => setTimeout(r, 200));
        waited += 200;
      }

      return {
        success: true,
        message: `Discord bot connected successfully as ${this.botTag || 'Apexion Bot'}.`,
        botTag: this.botTag,
      };
    } catch (err: any) {
      this.initError = err?.message || 'Login failed';
      return {
        success: false,
        message: `Failed to connect with token: ${err?.message || 'Invalid bot token'}`,
      };
    }
  }

  public async forceRestart(): Promise<{ success: boolean; message: string }> {
    try {
      await this.stop();
      this.isExplicitlyStopped = false;
      await this.start();
      return { success: true, message: 'Discord bot rebooted successfully.' };
    } catch (err: any) {
      return { success: false, message: err?.message || 'Failed to restart bot.' };
    }
  }

  public async setTargetMode(target: 'dev' | 'published' | 'disabled'): Promise<void> {
    await serverStorage.setBotTarget(target);
    const isPublishedInstance = CURRENT_ENV === 'published';
    const shouldRun = target !== 'disabled' && (
      (isPublishedInstance && target !== 'dev') ||
      (!isPublishedInstance && target === 'dev')
    );

    if (shouldRun) {
      console.log(`[Apexion Bot] Activating on ${CURRENT_ENV}...`);
      this.isExplicitlyStopped = false;
      await this.start();
    } else {
      console.log(`[Apexion Bot] Standing down on ${CURRENT_ENV} (target is now ${target})...`);
      await this.stop();
    }
  }

  private async loadExistingApplicationEmojis(): Promise<void> {
    try {
      const app = this.client.application as any;
      if (!app?.emojis) return;

      const emojis = await app.emojis.fetch().catch(() => null);
      if (emojis) {
        emojis.forEach((e: any) => {
          if (e.name) {
            const cleanKey = e.name.toLowerCase().replace(/^(?:bhead_|head_)/, '');
            if (!this.playerEmojiCache.has(cleanKey) || e.name.startsWith('bhead_')) {
              this.playerEmojiCache.set(cleanKey, `<:${e.name}:${e.id}>`);
            }
          }
        });
      }
    } catch {}
  }

  private async registerSlashCommands() {
    const commands = [
      new SlashCommandBuilder()
        .setName('configure')
        .setDescription('Link your Aternos server with your session cookie')
        .addStringOption(o => o.setName('session').setDescription('Aternos session cookie').setRequired(true))
        .addStringOption(o => o.setName('server').setDescription('Optional server name/IP to link directly (e.g. myserver.aternos.me)').setRequired(false)),

      new SlashCommandBuilder()
        .setName('start')
        .setDescription('Turn on your Minecraft server (only when offline)'),

      new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Turn off your Minecraft server (only when online)'),

      new SlashCommandBuilder()
        .setName('restart')
        .setDescription('Reboot your Minecraft server'),

      new SlashCommandBuilder()
        .setName('status')
        .setDescription('Check server online/offline status, players, and details'),

      new SlashCommandBuilder()
        .setName('players')
        .setDescription('View connected players and active player count'),
    ];

    try {
      const token = getBotToken();
      if (!token) {
        console.warn('[Apexion Bot] Slash commands registration skipped: no bot token configured.');
        return;
      }
      const rest = new REST({ version: '10' }).setToken(token);
      const targetId = this.botId || getBotClientId();

      // Register single set of global commands
      await rest.put(Routes.applicationCommands(targetId), {
        body: commands.map(cmd => cmd.toJSON()),
      });
      console.log('[Apexion Bot] Global slash commands registered.');

      // Clear any guild-specific slash commands so duplicates never appear
      for (const [guildId] of this.client.guilds.cache) {
        rest.put(Routes.applicationGuildCommands(targetId, guildId), {
          body: [],
        }).catch(() => {});
      }
    } catch (err: any) {
      console.warn('[Apexion Bot] Slash commands registration notice:', err?.message);
    }
  }

  /**
   * Resolves server context accurately for multi-user / multi-guild setups.
   * Ensures bindings configured in a server channel, guild, or DM are correctly found.
   */
  private resolveServerContext(contextId: string, userId?: string, guildId?: string | null) {
    // 1. Channel or direct context binding
    let binding = serverStorage.getDiscordBinding(contextId);

    // 2. Guild binding
    if (!binding && guildId) {
      binding = serverStorage.getDiscordBinding(guildId);
    }

    // 3. User binding
    if (!binding && userId) {
      binding = serverStorage.getDiscordBinding(userId);
    }

    if (binding) {
      const canonical = serverStorage.getCanonicalServerAddress(binding.serverAddress);
      const serverCookie = binding.serverCookie || serverStorage.getServerCookie(canonical) || '';
      return {
        serverAddress: canonical,
        sessionCookie: binding.sessionCookie,
        serverCookie,
        binding,
      };
    }

    // 4. Check active server configured in aternosService
    const cfg = aternosService.getConfig();
    if (cfg.serverAddress && cfg.sessionCookie) {
      const canonical = serverStorage.getCanonicalServerAddress(cfg.serverAddress);
      const profile = serverStorage.getProfile(canonical) || serverStorage.getProfile(cfg.serverAddress);
      return {
        serverAddress: canonical,
        sessionCookie: cfg.sessionCookie || profile?.sessionCookie || '',
        serverCookie: cfg.serverCookie || profile?.serverCookie || '',
        profile,
      };
    }

    // Never fall back to random arbitrary profiles that don't belong to this context
    return {
      serverAddress: '',
      sessionCookie: '',
      serverCookie: '',
    };
  }

  private async ensurePlayerHeadEmoji(playerName: string, guild?: any): Promise<string> {
    const cleanName = playerName.trim();
    if (!cleanName) return '👤';
    const cacheKey = cleanName.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 26);
    return this.playerEmojiCache.get(cacheKey) || '👤';
  }

  private getPlayerHeadEmoji(playerName: string): string {
    const cleanName = playerName.trim();
    if (!cleanName) return '👤';
    const cacheKey = cleanName.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 26);
    return this.playerEmojiCache.get(cacheKey) || '👤';
  }

  // Fast resolution of fresh Aternos + Minecraft live status
  private async getFastServerState(serverAddress: string, sessionCookie?: string, serverCookie?: string) {
    let state: AternosState = aternosService.getState(serverAddress);

    // Retrieve saved credentials if not passed directly
    if (!sessionCookie || !serverCookie) {
      const canonical = serverStorage.getCanonicalServerAddress(serverAddress);
      const p = serverStorage.getProfile(canonical) || serverStorage.getProfile(serverAddress);
      if (!sessionCookie && p?.sessionCookie) {
        sessionCookie = p.sessionCookie;
      }
      if (!serverCookie) {
        serverCookie = p?.serverCookie || serverStorage.getServerCookie(canonical) || serverStorage.getServerCookie(serverAddress);
      }
    }

    const now = Date.now();
    const isCold = !state.lastUpdated || state.lastUpdated === 0;
    const isStale = now - (state.lastUpdated || 0) > 25000;

    // Fast sync from Aternos: only when cold or stale, with a 1400ms quick-race
    if (sessionCookie && (isCold || isStale)) {
      try {
        const syncTimeout = new Promise<AternosState>(resolve => setTimeout(() => resolve(state), 1400));
        const synced = await Promise.race([
          aternosService.syncSessionState(serverAddress, { sessionCookie, serverCookie, serverAddress }),
          syncTimeout,
        ]);
        if (synced && synced.lastUpdated) {
          state = synced;
        }
      } catch {}
    }

    // Query Minecraft server status using target with actual port if available
    const targetWithPort = state.serverPort && !serverAddress.includes(':')
      ? `${serverAddress}:${state.serverPort}`
      : serverAddress;

    const live = await queryMinecraftServer(
      targetWithPort,
      state.dynip,
      state.playersOnline || 0,
      state.playerList || [],
      state.status === 'online' || state.status === 'starting'
    );

    // If server is verified offline or stopping, reset countdown states
    if (state.status === 'offline' || state.status === 'stopping') {
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
  private async buildStatusEmbed(
    serverAddress: string,
    state: any,
    live: any,
    guild?: any
  ): Promise<EmbedBuilder> {
    const canonicalAddr = serverStorage.getCanonicalServerAddress(serverAddress);

    // Robust offline/online check: online if Aternos reports online OR Minecraft query reports online
    const isStopping = state.status === 'stopping';
    const isStarting = state.status === 'starting';
    const isQueue = state.status === 'queue';
    const isAternosOnline = state.status === 'online';
    const isLiveOnline = Boolean(live?.online) && !isAternosOfflineIndicator(live?.version, live?.motd);

    let isOnline = false;
    let statusText = '🔴 Offline';
    let color = 0xef4444; // Red

    if (isStopping) {
      statusText = '🟠 Stopping';
      color = 0xf97316; // Orange
    } else if (isStarting) {
      statusText = `🟡 ${state.rawStatus || 'Starting ...'}`;
      color = 0xf59e0b; // Amber
    } else if (isQueue) {
      statusText = '⏳ In Queue';
      color = 0xf59e0b; // Amber
    } else if (isAternosOnline || isLiveOnline) {
      isOnline = true;
      statusText = '🟢 Online';
      color = 0x10b981; // Emerald Green
    } else {
      isOnline = false;
      statusText = '🔴 Offline';
      color = 0xef4444; // Red
    }

    const playerCount = isOnline ? Math.max(live?.players?.online || 0, state.playersOnline || 0) : 0;
    const maxCount = live?.players?.max || state.maxPlayers || 20;

    // Active player names
    const playerNames: string[] = [];
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

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`🎮 ${canonicalAddr}`)
      .setDescription(
        isOnline
          ? `🟢 Server is **Online** and joinable.`
          : isStarting
          ? `🟡 Server is **Starting** — please allow 1-2 minutes for world load.`
          : isStopping
          ? `🟠 Server is **Stopping** — saving world data.`
          : `🔴 Server is **Offline**.`
      )
      .addFields(
        { name: 'Status', value: `**${statusText}**`, inline: true },
        { name: 'Players', value: `\`${playerCount}/${maxCount}\` online`, inline: true },
        { name: 'Server Address', value: `\`${canonicalAddr}:${state.serverPort || 25565}\``, inline: true }
      );

    if (isOnline && state.dynip) {
      embed.addFields({ name: 'Direct Connect IP', value: `\`${state.dynip}\``, inline: true });
    }

    if (state.software || live?.version || state.version) {
      embed.addFields({
        name: 'Version & Software',
        value: `${state.software || 'Fabric'} ${live?.version || state.version || '1.20.4'}`,
        inline: true,
      });
    }

    // Fast synchronous player list rendering (0ms lag, no Discord REST emoji rate limits)
    if (isOnline && playerNames.length > 0) {
      const playerListItems = playerNames.map(n => {
        const head = this.getPlayerHeadEmoji(n);
        return `${head} **${n}**`;
      });
      embed.addFields({
        name: `👤 Connected Players (${playerNames.length})`,
        value: playerListItems.join('  •  '),
        inline: false,
      });
    }

    if (isOnline && (state.motd || live?.motd)) {
      embed.addFields({
        name: '📜 MOTD',
        value: `*${state.motd || live?.motd}*`,
        inline: false,
      });
    }

    // Keepalive Timer (only when genuinely online)
    if (isOnline) {
      if (playerCount > 0) {
        embed.addFields({
          name: '⏱️ Keepalive Timer',
          value: `🟢 **Paused** (${playerCount} active player${playerCount > 1 ? 's' : ''} connected)`,
          inline: false,
        });
      } else if (state.countdownActive && typeof state.countdownSeconds === 'number' && state.countdownSeconds > 0) {
        const secs = state.countdownSeconds;
        const mins = Math.floor(secs / 60);
        const s = secs % 60;
        const formatted = state.countdownFormatted || `${mins}:${s < 10 ? '0' : ''}${s}`;
        const targetEpoch = Math.floor(Date.now() / 1000) + secs;

        embed.addFields({
          name: '⏱️ Keepalive Timer',
          value: `\`${formatted}\` remaining • Auto-shutdown <t:${targetEpoch}:R>`,
          inline: false,
        });
      }
    } else if (!isStarting && !isStopping) {
      embed.addFields({
        name: '💡 Action',
        value: 'Server is currently offline. Use `/start` to turn it on!',
        inline: false,
      });
    }

    embed.setFooter({ text: 'Apexion' });
    embed.setTimestamp();

    return embed;
  }

  // Handle Slash Command
  private async handleSlashCommand(interaction: ChatInputCommandInteraction) {
    const { commandName, user, guildId, channelId } = interaction;
    const contextId = channelId || guildId || user.id;

    // 1. MUST acknowledge (defer) IMMEDIATELY within milliseconds so Discord NEVER times out!
    // flags: MessageFlags.Ephemeral ensures the message is private to only the user who typed the command
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
    } catch (err: any) {
      console.warn(`[Apexion] Could not defer /${commandName}:`, err?.message);
    }

    // 2. Concurrently clean up the previous response in background (non-blocking)
    const prevInteraction = this.lastUserReplies.get(user.id);
    this.lastUserReplies.set(user.id, interaction);

    if (prevInteraction && prevInteraction.id !== interaction.id) {
      prevInteraction.deleteReply().catch(() => {});
    }

    if (channelId && this.lastChannelMessageIds.has(channelId)) {
      const prevMsgId = this.lastChannelMessageIds.get(channelId);
      this.lastChannelMessageIds.delete(channelId);
      if (prevMsgId && interaction.channel && 'messages' in interaction.channel) {
        (interaction.channel as any).messages.delete(prevMsgId).catch(() => {});
      }
    }

    try {
      switch (commandName) {
        case 'configure': {
          const rawSession = interaction.options.getString('session', true);
          const session = rawSession
            .replace(/^ATERNOS_SESSION=/i, '')
            .replace(/;.*$/, '')
            .replace(/^["']|["']$/g, '')
            .trim();

          const discovered: DiscoveredServer[] = await aternosService.discoverServersFromSession(session);

          if (discovered.length === 1) {
            const matchedServer = discovered[0];
            const canonicalAddr = serverStorage.getCanonicalServerAddress(matchedServer.serverAddress);
            
            // Save bindings for channel, guild, and user
            serverStorage.setDiscordBinding({
              guildIdOrUserId: contextId,
              serverAddress: canonicalAddr,
              sessionCookie: session,
              serverCookie: matchedServer.serverCookie,
              configuredBy: user.username,
              updatedAt: Date.now(),
            });

            if (guildId && guildId !== contextId) {
              serverStorage.setDiscordBinding({
                guildIdOrUserId: guildId,
                serverAddress: canonicalAddr,
                sessionCookie: session,
                serverCookie: matchedServer.serverCookie,
                configuredBy: user.username,
                updatedAt: Date.now(),
              });
            }

            if (user.id !== contextId) {
              serverStorage.setDiscordBinding({
                guildIdOrUserId: user.id,
                serverAddress: canonicalAddr,
                sessionCookie: session,
                serverCookie: matchedServer.serverCookie,
                configuredBy: user.username,
                updatedAt: Date.now(),
              });
            }

            await aternosService.updateConfig({
              sessionCookie: session,
              serverCookie: matchedServer.serverCookie,
              serverAddress: canonicalAddr,
            });

            serverStorage.addDiscordLog({
              user: user.tag,
              command: '/configure',
              serverAddress: canonicalAddr,
              status: 'success',
              message: `Linked ${canonicalAddr}`,
            });

            const embed = new EmbedBuilder()
              .setColor(0x10b981)
              .setTitle('⚙️ Aternos Server Configured')
              .setDescription(`Successfully linked **${canonicalAddr}** to Apexion.\nYou can now control your server using slash commands.`)
              .addFields(
                { name: '🌐 Server Address', value: `\`${canonicalAddr}\``, inline: true },
                { name: '🔑 Server ID', value: `\`${matchedServer.id}\``, inline: true },
                { name: '🔒 Session Auth', value: '✅ Synced & Active', inline: true },
                {
                  name: '🎮 Control Commands',
                  value: '`/status` — Check online status & player count\n`/players` — View online players\n`/start` — Turn on server\n`/stop` — Turn off server\n`/restart` — Reboot server',
                }
              )
              .setFooter({ text: 'Apexion' })
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            return;
          }

          if (discovered.length === 0) {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('❌ No Aternos Servers Found')
              .setDescription(
                'Could not locate any servers on this Aternos account.\nPlease make sure your `ATERNOS_SESSION` cookie is copied from your browser while logged into [aternos.org](https://aternos.org/servers/).'
              )
              .setFooter({ text: 'Apexion' });
            await interaction.editReply({ embeds: [embed] });
            return;
          }

          const menuCustomId = `select_srv_${user.id}_${Date.now()}`;
          const pendingData: PendingSession = {
            session,
            servers: discovered,
            contextId,
            guildId: guildId || undefined,
            userId: user.id,
            userName: user.username,
          };
          this.pendingSelections.set(menuCustomId, pendingData);
          serverStorage.setPendingSelection(menuCustomId, pendingData, 86400);
          serverStorage.setPendingSelection(`user_${user.id}`, pendingData, 86400);
          serverStorage.saveUserSession(user.id, session);

          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(menuCustomId)
            .setPlaceholder('Choose a server to link...')
            .addOptions(
              discovered.map(s => {
                const encodedVal = `${s.id}:::${s.serverAddress}:::${s.serverCookie || s.id}`;
                return new StringSelectMenuOptionBuilder()
                  .setLabel(s.serverAddress.slice(0, 100))
                  .setDescription(`Server ID: ${s.id}`.slice(0, 100))
                  .setValue(encodedVal)
                  .setEmoji('🎮');
              })
            );

          const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

          const embed = new EmbedBuilder()
            .setColor(0x3b82f6)
            .setTitle('📋 Choose Your Aternos Server')
            .setDescription(`Found **${discovered.length} server(s)** linked to your session. Select the server you want to control from the dropdown below:`)
            .addFields(
              discovered.map((s, idx) => ({
                name: `${idx + 1}. ${s.serverAddress}`,
                value: `Server ID: \`${s.id}\``,
                inline: true,
              }))
            )
            .setFooter({ text: 'Select an option below to complete setup' });

          await interaction.editReply({ embeds: [embed], components: [actionRow] });
          break;
        }

        case 'start': {
          const ctx = this.resolveServerContext(contextId, user.id, guildId);
          const cached = aternosService.getState(ctx.serverAddress);

          if (cached.status === 'online') {
            const embed = new EmbedBuilder()
              .setColor(0x10b981)
              .setTitle(`⚠️ ${ctx.serverAddress} is Already Online!`)
              .setDescription(`Server is already online and joinable.`)
              .addFields(
                { name: 'Status', value: '🟢 **Online**', inline: true },
                { name: 'Tip', value: 'Use `/status` to view players or `/stop` to shut down.', inline: false }
              )
              .setFooter({ text: 'Apexion' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }

          if (cached.status === 'starting' || cached.status === 'queue') {
            const embed = new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle(`⏳ ${ctx.serverAddress} is Booting Up!`)
              .setDescription(`Server is already in the starting sequence. Please give it 1 to 2 minutes.`)
              .addFields({ name: 'Current Status', value: `🟡 ${cached.rawStatus || 'Starting ...'}` })
              .setFooter({ text: 'Apexion' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }

          const res = await aternosService.startServer(ctx.serverAddress, {
            sessionCookie: ctx.sessionCookie,
            serverCookie: ctx.serverCookie,
            serverAddress: ctx.serverAddress,
          });

          serverStorage.addDiscordLog({
            user: user.tag,
            command: '/start',
            serverAddress: ctx.serverAddress,
            status: res.success ? 'success' : 'error',
            message: res.message,
          });

          if (res.success) {
            const embed = new EmbedBuilder()
              .setColor(0x10b981)
              .setTitle(`🚀 Starting ${ctx.serverAddress}`)
              .setDescription(`Start signal sent to Aternos. The server is booting up and will be ready for players in ~1-2 minutes.`)
              .addFields(
                { name: 'Status', value: '🟡 **Starting ...**', inline: true },
                { name: 'Estimated Time', value: '~60-90 seconds', inline: true },
                { name: 'Tip', value: 'Run `/status` in a moment to track startup progress.', inline: false }
              )
              .setFooter({ text: 'Apexion' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } else {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('❌ Start Command Failed')
              .setDescription(`Aternos rejected the start request:\n\`${res.message}\`\nVerify that your session cookie is valid via \`/configure\`.`)
              .setFooter({ text: 'Apexion' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          }
          break;
        }

        case 'stop': {
          const ctx = this.resolveServerContext(contextId, user.id, guildId);
          const cached = aternosService.getState(ctx.serverAddress);

          if (cached.status === 'offline') {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle(`⚠️ ${ctx.serverAddress} is Already Offline!`)
              .setDescription(`Cannot stop a server that isn't running.\nUse \`/start\` if you would like to boot it up.`)
              .setFooter({ text: 'Apexion' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }

          if (cached.status === 'stopping') {
            const embed = new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle(`⏳ ${ctx.serverAddress} is Shutting Down!`)
              .setDescription(`Server is already shutting down and saving world files.`)
              .setFooter({ text: 'Apexion' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }

          const res = await aternosService.stopServer(ctx.serverAddress, {
            sessionCookie: ctx.sessionCookie,
            serverCookie: ctx.serverCookie,
            serverAddress: ctx.serverAddress,
          });

          serverStorage.addDiscordLog({
            user: user.tag,
            command: '/stop',
            serverAddress: ctx.serverAddress,
            status: res.success ? 'success' : 'error',
            message: res.message,
          });

          if (res.success) {
            const embed = new EmbedBuilder()
              .setColor(0xf97316)
              .setTitle(`🛑 Stopping ${ctx.serverAddress}`)
              .setDescription(`Stop signal sent to Aternos. World progress is being saved and the server is powering down safely.`)
              .addFields({ name: 'Status', value: '🟠 **Stopping ...**', inline: true })
              .setFooter({ text: 'Apexion' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } else {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('❌ Stop Command Failed')
              .setDescription(`Aternos returned: \`${res.message}\``)
              .setFooter({ text: 'Apexion' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          }
          break;
        }

        case 'restart': {
          const ctx = this.resolveServerContext(contextId, user.id, guildId);

          const res = await aternosService.restartServer(ctx.serverAddress, {
            sessionCookie: ctx.sessionCookie,
            serverCookie: ctx.serverCookie,
            serverAddress: ctx.serverAddress,
          });

          const embed = new EmbedBuilder()
            .setColor(res.success ? 0x3b82f6 : 0xef4444)
            .setTitle(res.success ? `🔄 Rebooting ${ctx.serverAddress}` : '❌ Restart Failed')
            .setDescription(`Restart signal sent to Aternos. The server will cycle off and boot back up automatically.`)
            .addFields({ name: 'Result', value: res.message })
            .setFooter({ text: 'Apexion' })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
          break;
        }

        case 'status': {
          const ctx = this.resolveServerContext(contextId, user.id, guildId);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);

          const embed = await this.buildStatusEmbed(ctx.serverAddress, state, live, interaction.guild);
          await interaction.editReply({ embeds: [embed] });
          break;
        }

        case 'players': {
          const ctx = this.resolveServerContext(contextId, user.id, guildId);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);

          const isStopping = state.status === 'stopping';
          const isStarting = state.status === 'starting';
          const isAternosOnline = state.status === 'online';
          const isLiveOnline = Boolean(live?.online) && !isAternosOfflineIndicator(live?.version, live?.motd);
          const isOnline = !isStopping && !isStarting && (isAternosOnline || isLiveOnline);

          if (isStarting) {
            const embed = new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle(`⏳ Server is Starting`)
              .setDescription(`**${ctx.serverAddress}** is currently booting up. Players can join once world loading finishes.`)
              .setFooter({ text: 'Apexion' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }

          if (!isOnline) {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle(`🔴 Server is Offline`)
              .setDescription(`**${ctx.serverAddress}** is currently offline. Active players cannot be queried.\nUse \`/start\` to bring the server online!`)
              .setFooter({ text: 'Apexion' })
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            break;
          }

          // Combine unique players
          const playerNames = new Set<string>();
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
            const embed = new EmbedBuilder()
              .setColor(0x10b981)
              .setTitle(`👥 No Players Online (0/${max})`)
              .setDescription(`There are currently **0** players connected to **${ctx.serverAddress}**.\nThe server is online and ready for players to join!`)
              .setFooter({ text: 'Apexion' })
              .setTimestamp();

            if (state.countdownActive && typeof state.countdownSeconds === 'number' && state.countdownSeconds > 0) {
              const secs = state.countdownSeconds;
              const mins = Math.floor(secs / 60);
              const s = secs % 60;
              const formatted = state.countdownFormatted || `${mins}:${s < 10 ? '0' : ''}${s}`;
              const targetEpoch = Math.floor(Date.now() / 1000) + secs;

              embed.addFields({
                name: '⏱️ Keepalive Timer',
                value: `\`${formatted}\` remaining • Auto-shutdown <t:${targetEpoch}:R>`,
                inline: false,
              });
            }

            await interaction.editReply({ embeds: [embed] });
            break;
          }

          const embed = new EmbedBuilder()
            .setColor(0x10b981)
            .setTitle(`👥 Connected Players (${count}/${max})`)
            .setDescription(`Active players currently connected to **${ctx.serverAddress}**:`)
            .setFooter({ text: 'Apexion' })
            .setTimestamp();

          const playerLines = combinedList.map((name, idx) => {
            const headEmoji = this.getPlayerHeadEmoji(name);
            return `**${idx + 1}.** ${headEmoji} **${name}**`;
          });
          embed.addFields({ name: 'Player List', value: playerLines.join('\n'), inline: false });

          await interaction.editReply({ embeds: [embed] });
          break;
        }

        default:
          await interaction.editReply({ content: 'Unknown command.' });
      }
    } catch (err: any) {
      console.error(`[Apexion /${commandName} Error]`, err);
      try {
        if (interaction.deferred && !interaction.replied) {
          await interaction.editReply({ content: `❌ Command Error: ${err.message || 'Operation failed'}` });
        } else if (!interaction.replied) {
          await interaction.reply({ content: `❌ Command Error: ${err.message || 'Operation failed'}`, ephemeral: true });
        }
      } catch {}
    }
  }

  // Handle Interactive Select Menu Selection for /configure
  private async handleSelectMenu(interaction: StringSelectMenuInteraction) {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }
    } catch (err: any) {
      console.warn('[Apexion] Could not defer select menu:', err?.message);
      return;
    }

    const { customId, values, user } = interaction;
    const rawVal = values[0] || '';
    let chosenId = rawVal;
    let chosenAddress = '';
    let chosenCookie = '';

    if (rawVal.includes(':::')) {
      const parts = rawVal.split(':::');
      chosenId = parts[0];
      chosenAddress = parts[1] || '';
      chosenCookie = parts[2] || '';
    }

    // Multi-tier recovery: check in-memory -> persistent pending selection -> user pending selection
    let pending: PendingSession | undefined =
      this.pendingSelections.get(customId) ||
      (await serverStorage.getPendingSelection(customId)) ||
      (await serverStorage.getPendingSelection(`user_${user.id}`));

    const fallbackSession = await serverStorage.getUserSession(user.id);
    const sessionToUse = pending?.session || fallbackSession;

    let chosenServer = pending?.servers?.find(s => s.id === chosenId || s.serverAddress === chosenAddress);
    if (!chosenServer && chosenAddress) {
      chosenServer = {
        id: chosenId,
        name: chosenAddress,
        serverAddress: chosenAddress,
        serverCookie: chosenCookie || chosenId,
      };
    }

    if (!chosenServer || !sessionToUse) {
      await interaction.followUp({
        content: '⚠️ Selection could not be restored. Please run `/configure` with your session again.',
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    try {
      const canonicalAddr = serverStorage.getCanonicalServerAddress(chosenAddress || chosenServer.serverAddress);
      const serverCookie = chosenCookie || chosenServer.serverCookie || chosenServer.id;
      const effectiveContext = pending?.contextId || interaction.channelId || user.id;
      const effectiveGuild = pending?.guildId || interaction.guildId;

      serverStorage.setDiscordBinding({
        guildIdOrUserId: effectiveContext,
        serverAddress: canonicalAddr,
        sessionCookie: sessionToUse,
        serverCookie,
        configuredBy: pending?.userName || user.username,
        updatedAt: Date.now(),
      });

      if (effectiveGuild && effectiveGuild !== effectiveContext) {
        serverStorage.setDiscordBinding({
          guildIdOrUserId: effectiveGuild,
          serverAddress: canonicalAddr,
          sessionCookie: sessionToUse,
          serverCookie,
          configuredBy: pending?.userName || user.username,
          updatedAt: Date.now(),
        });
      }

      if (user.id !== effectiveContext) {
        serverStorage.setDiscordBinding({
          guildIdOrUserId: user.id,
          serverAddress: canonicalAddr,
          sessionCookie: sessionToUse,
          serverCookie,
          configuredBy: pending?.userName || user.username,
          updatedAt: Date.now(),
        });
      }

      await aternosService.updateConfig({
        sessionCookie: sessionToUse,
        serverCookie,
        serverAddress: canonicalAddr,
      });

      serverStorage.addDiscordLog({
        user: user.tag,
        command: '/configure [SELECT]',
        serverAddress: canonicalAddr,
        status: 'success',
        message: `Selected and bound ${canonicalAddr}`,
      });

      const embed = new EmbedBuilder()
        .setColor(0x10b981)
        .setTitle('✅ Aternos Server Linked Successfully')
        .setDescription(`Successfully linked **${canonicalAddr}** (ID: \`${chosenServer.id}\`) to Apexion.\nYou can now control your server directly!`)
        .addFields(
          { name: '🌐 Server Address', value: `\`${canonicalAddr}\``, inline: true },
          { name: '🔑 Server ID', value: `\`${chosenServer.id}\``, inline: true },
          { name: '🔒 Session Auth', value: '✅ Synced & Active', inline: true },
          {
            name: '🎮 Control Commands',
            value: '`/status` — Check online status & player count\n`/players` — View online players\n`/start` — Turn on server\n`/stop` — Turn off server\n`/restart` — Reboot server',
          }
        )
        .setFooter({ text: 'Apexion' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], components: [] });
      this.pendingSelections.delete(customId);
      serverStorage.deletePendingSelection(customId);
      serverStorage.deletePendingSelection(`user_${user.id}`);
    } catch (err: any) {
      console.error('[Apexion Select Menu Error]', err);
    }
  }

  public getBotStatus() {
    const token = getBotToken();
    const maskedToken = token
      ? token.length > 10
        ? `${token.slice(0, 4)}••••••••${token.slice(-4)}`
        : '••••••••'
      : '';

    return {
      isReady: this.isReady,
      configured: Boolean(token && token.trim().length > 10),
      maskedToken,
      clientId: getBotClientId(),
      currentEnv: CURRENT_ENV,
      activeTarget: serverStorage.getBotTarget(),
      botTag: this.botTag || (this.isReady ? 'Apexion Bot' : 'Standby / Disconnected'),
      botId: this.botId || getBotClientId(),
      guildsCount: this.client.guilds?.cache?.size || 0,
      ping: this.client.ws?.ping || this.lastPing || 0,
      initError: this.initError,
      recentLogs: serverStorage.getDiscordLogs(),
      bindings: serverStorage.getAllDiscordBindings(),
    };
  }
}

export const discordBot = new DiscordBotService();
