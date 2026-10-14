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
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { aternosService } from './aternosAutomation.ts';
import type { AternosState } from '../types/aternos.ts';
import { serverStorage } from './serverStorage.ts';
import { queryMinecraftServer, isAternosOfflineIndicator } from './mcPing.ts';
import { CURRENT_ENV, GLOBAL_KEYS, redis, getRedisJson, setRedisJson } from './redisClient.ts';

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'MTU1NTMzMDg1Njc1Nzc1NTk5NA.GLEqGe.jXMPh6b0PV8HEOB0sKBRbGTkOTBxgGmiX3tSOQ';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1555330856757755994';

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
    });

    this.setupEventHandlers();
    this.startWatchdog();
  }

  private setupEventHandlers() {
    this.client.once('ready', async () => {
      this.isReady = true;
      this.botTag = this.client.user?.tag || 'Apexion Bot';
      this.botId = this.client.user?.id || DISCORD_CLIENT_ID;
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

    this.client.on('shardDisconnect', (event, shardId) => {
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
  private startWatchdog() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(async () => {
      try {
        const globalTarget = await getRedisJson<string>(GLOBAL_KEYS.BOT_MODE, 'published');
        const shouldRunHere = globalTarget === CURRENT_ENV;

        if (shouldRunHere) {
          if (!this.isReady && !this.isExplicitlyStopped) {
            console.log(`[Apexion Bot Watchdog] This instance (${CURRENT_ENV}) is designated active. Connecting...`);
            await this.start().catch(() => {});
          }
          // Renew active lease in Upstash Redis (TTL 25s)
          await setRedisJson(GLOBAL_KEYS.BOT_LEADER, { env: CURRENT_ENV, heartbeat: Date.now() }, 25);
        } else {
          // If we are running but mode points to another instance, gracefully disconnect
          if (this.isReady || this.client.isReady()) {
            console.log(`[Apexion Bot Watchdog] Active mode is "${globalTarget}". Disconnecting ${CURRENT_ENV} to prevent token collision.`);
            await this.stop().catch(() => {});
          }
        }
      } catch {}
    }, 10000);
  }

  private scheduleReconnect() {
    if (this.isExplicitlyStopped) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.isReady && !this.isExplicitlyStopped && DISCORD_BOT_TOKEN) {
        const activeTarget = serverStorage.getBotTarget();
        if (activeTarget === CURRENT_ENV) {
          console.log(`[Apexion Bot (${CURRENT_ENV})] Attempting gateway reconnect...`);
          await this.start().catch(() => {});
        }
      }
    }, 5000);
  }

  public async start(): Promise<void> {
    const activeTarget = serverStorage.getBotTarget();
    if (activeTarget !== CURRENT_ENV) {
      console.log(`[Apexion Bot] Standby on ${CURRENT_ENV}. Active target is "${activeTarget}". Bot will not connect here to prevent token collisions.`);
      this.isExplicitlyStopped = true;
      return;
    }

    if (!DISCORD_BOT_TOKEN) {
      console.warn('[Apexion Bot] No token provided.');
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

  public async setTargetMode(target: 'dev' | 'published' | 'disabled'): Promise<void> {
    await serverStorage.setBotTarget(target);
    if (target === CURRENT_ENV) {
      console.log(`[Apexion Bot] Activating on ${CURRENT_ENV}...`);
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
        .addStringOption(o => o.setName('session').setDescription('Aternos session cookie').setRequired(true)),

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
      const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
      const targetId = this.botId || DISCORD_CLIENT_ID;

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
      return {
        serverAddress: canonical,
        sessionCookie: binding.sessionCookie,
        serverCookie: binding.serverCookie,
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

    // 5. Fallback to first available profile in server storage
    const allProfiles = serverStorage.getAllProfiles();
    if (allProfiles.length > 0) {
      const p = allProfiles[0];
      const canonical = serverStorage.getCanonicalServerAddress(p.serverIp || p.name);
      return {
        serverAddress: canonical,
        sessionCookie: p.sessionCookie,
        serverCookie: p.serverCookie,
        profile: p,
      };
    }

    const defaultCanonical = 'Bang_Bros_SMP.aternos.me';
    return {
      serverAddress: defaultCanonical,
      sessionCookie: '',
      serverCookie: '',
    };
  }

  private async ensurePlayerHeadEmoji(playerName: string, guild?: any): Promise<string> {
    const cleanName = playerName.trim();
    if (!cleanName) return '👤';
    const cacheKey = cleanName.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 26);

    // 1. Check in-memory cache
    if (this.playerEmojiCache.has(cacheKey)) {
      return this.playerEmojiCache.get(cacheKey)!;
    }

    const emojiName = `head_${cacheKey}`;
    const legacyName = `bhead_${cacheKey}`;

    // 2. Check application emojis cache
    const app = this.client.application as any;
    try {
      if (app?.emojis?.cache) {
        const found = app.emojis.cache.find((e: any) => e.name === emojiName || e.name === legacyName);
        if (found) {
          const formatted = `<:${found.name}:${found.id}>`;
          this.playerEmojiCache.set(cacheKey, formatted);
          return formatted;
        }
      }
    } catch {}

    // 3. Check guild emojis cache if available
    try {
      if (guild?.emojis?.cache) {
        const found = guild.emojis.cache.find((e: any) => e.name === emojiName || e.name === legacyName);
        if (found) {
          const formatted = `<:${found.name}:${found.id}>`;
          this.playerEmojiCache.set(cacheKey, formatted);
          return formatted;
        }
      }
    } catch {}

    // 4. Dynamically upload player head avatar to Discord Application Emojis or Guild
    try {
      const avatarUrl = `https://mc-heads.net/avatar/${encodeURIComponent(cleanName)}/32`;
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), 2000);
      const res = await fetch(avatarUrl, { signal: ac.signal });
      clearTimeout(tm);
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);

        // Upload as application emoji
        if (app?.emojis?.create) {
          try {
            const newEmoji = await app.emojis.create({
              attachment: buffer,
              name: emojiName,
            });
            if (newEmoji?.id) {
              const formatted = `<:${newEmoji.name}:${newEmoji.id}>`;
              this.playerEmojiCache.set(cacheKey, formatted);
              return formatted;
            }
          } catch (appErr: any) {
            console.warn('[Apexion Bot] App emoji upload notice:', appErr?.message);
          }
        }

        // Upload as guild emoji if application emoji wasn't possible
        if (guild?.emojis?.create) {
          try {
            const newEmoji = await guild.emojis.create({
              attachment: buffer,
              name: emojiName,
            });
            if (newEmoji?.id) {
              const formatted = `<:${newEmoji.name}:${newEmoji.id}>`;
              this.playerEmojiCache.set(cacheKey, formatted);
              return formatted;
            }
          } catch (guildErr: any) {
            console.warn('[Apexion Bot] Guild emoji upload notice:', guildErr?.message);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[Apexion Bot] Could not fetch avatar for ${cleanName}:`, err?.message);
    }

    return '👤';
  }

  private getPlayerHeadEmoji(playerName: string): string {
    const cleanName = playerName.trim();
    if (!cleanName) return '👤';
    const cacheKey = cleanName.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 26);
    return this.playerEmojiCache.get(cacheKey) || '👤';
  }

  // Fast resolution of fresh Aternos + Minecraft live status
  private async getFastServerState(serverAddress: string, sessionCookie?: string) {
    let state: AternosState = aternosService.getState(serverAddress);

    // Retrieve saved credentials if not passed directly
    if (!sessionCookie) {
      const p = serverStorage.getProfile(serverAddress) || serverStorage.getProfile(serverStorage.getCanonicalServerAddress(serverAddress));
      if (p?.sessionCookie) {
        sessionCookie = p.sessionCookie;
      }
    }

    // Fast sync from Aternos: give up to 7000ms if cold/stale/offline so first run always resolves real state
    const isCold = !state.lastUpdated || state.lastUpdated === 0;
    const isStale = Date.now() - (state.lastUpdated || 0) > 4000;
    if (sessionCookie && (isCold || isStale || state.status === 'offline')) {
      try {
        const syncTimeout = new Promise<AternosState>(resolve => setTimeout(() => resolve(state), 7000));
        const synced = await Promise.race([aternosService.syncSessionState(serverAddress), syncTimeout]);
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

    // Online players list with small player head next to each name (no big thumbnail)
    if (isOnline && playerNames.length > 0) {
      const playerListItems = await Promise.all(
        playerNames.map(async n => {
          const head = await this.ensurePlayerHeadEmoji(n, guild);
          return `${head} **${n}**`;
        })
      );
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
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }
    } catch (err: any) {
      console.warn(`[Apexion] Could not defer /${commandName}:`, err?.message);
      return;
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
          this.pendingSelections.set(menuCustomId, {
            session,
            servers: discovered,
            contextId,
            guildId: guildId || undefined,
            userId: user.id,
            userName: user.username,
          });

          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(menuCustomId)
            .setPlaceholder('Choose a server to link...')
            .addOptions(
              discovered.map(s =>
                new StringSelectMenuOptionBuilder()
                  .setLabel(s.serverAddress)
                  .setDescription(`Server ID: ${s.id}`)
                  .setValue(s.id)
                  .setEmoji('🎮')
              )
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
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);

          const isOnline = !isAternosOfflineIndicator(live?.version, live?.motd) && Boolean(live?.online) && state.status !== 'offline';

          if (isOnline) {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle(`⚠️ ${ctx.serverAddress} is Already Online!`)
              .setDescription(`Server is already online and joinable.`)
              .addFields(
                { name: 'Status', value: '🟢 **Online**', inline: true },
                { name: 'Players', value: `\`${live.players?.online || 0}/${live.players?.max || 20}\``, inline: true },
                { name: 'Tip', value: 'Use `/stop` to shut down, or `/restart` to reboot.', inline: false }
              )
              .setFooter({ text: 'Apexion' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }

          if (state.status === 'starting' || state.status === 'queue') {
            const embed = new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle(`⏳ ${ctx.serverAddress} is Booting Up!`)
              .setDescription(`Server is already in the starting sequence. Please give it 1 to 2 minutes.`)
              .addFields({ name: 'Current Status', value: `🟡 ${state.rawStatus || 'Starting ...'}` })
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
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);

          const isOnline = !isAternosOfflineIndicator(live?.version, live?.motd) && (live?.online || state.status === 'online');

          if (!isOnline && state.status !== 'starting' && state.status !== 'stopping') {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle(`⚠️ ${ctx.serverAddress} is Already Offline!`)
              .setDescription(`Cannot stop a server that isn't running.\nUse \`/start\` if you would like to boot it up.`)
              .setFooter({ text: 'Apexion' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }

          if (state.status === 'stopping') {
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

          const playerLines = await Promise.all(
            combinedList.map(async (name, idx) => {
              const headEmoji = await this.ensurePlayerHeadEmoji(name, interaction.guild);
              return `**${idx + 1}.** ${headEmoji} **${name}**`;
            })
          );
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
    const pending = this.pendingSelections.get(customId);

    if (!pending) {
      await interaction.followUp({
        content: '⚠️ This server selection menu has expired. Please run `/configure` again.',
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    const selectedId = values[0];
    const chosenServer = pending.servers.find(s => s.id === selectedId);

    if (!chosenServer) {
      await interaction.followUp({
        content: '⚠️ Selected server was not found.',
        ephemeral: true,
      }).catch(() => {});
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
        updatedAt: Date.now(),
      });

      if (pending.guildId && pending.guildId !== pending.contextId) {
        serverStorage.setDiscordBinding({
          guildIdOrUserId: pending.guildId,
          serverAddress: canonicalAddr,
          sessionCookie: pending.session,
          serverCookie: chosenServer.serverCookie,
          configuredBy: pending.userName,
          updatedAt: Date.now(),
        });
      }

      if (pending.userId !== pending.contextId) {
        serverStorage.setDiscordBinding({
          guildIdOrUserId: pending.userId,
          serverAddress: canonicalAddr,
          sessionCookie: pending.session,
          serverCookie: chosenServer.serverCookie,
          configuredBy: pending.userName,
          updatedAt: Date.now(),
        });
      }

      await aternosService.updateConfig({
        sessionCookie: pending.session,
        serverCookie: chosenServer.serverCookie,
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
    } catch (err: any) {
      console.error('[Apexion Select Menu Error]', err);
    }
  }

  public getBotStatus() {
    return {
      isReady: this.isReady,
      currentEnv: CURRENT_ENV,
      activeTarget: serverStorage.getBotTarget(),
      botTag: this.botTag || (this.isReady ? 'Apexion#3859' : 'Standby / Disconnected'),
      botId: this.botId,
      guildsCount: this.client.guilds?.cache?.size || 0,
      ping: this.client.ws?.ping || this.lastPing || 0,
      initError: this.initError,
      recentLogs: serverStorage.getDiscordLogs(),
      bindings: serverStorage.getAllDiscordBindings(),
    };
  }
}

export const discordBot = new DiscordBotService();
