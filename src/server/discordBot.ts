import 'dotenv/config';
import fs from 'fs';
import path from 'path';
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

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'MTU1NTMzMDg1Njc1Nzc1NTk5NA.GLEqGe.jXMPh6b0PV8HEOB0sKBRbGTkOTBxgGmiX3tSOQ';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1555330856757755994';

export const IS_PRODUCTION =
  process.env.NODE_ENV === 'production' ||
  !fs.existsSync(path.resolve(process.cwd(), 'vite.config.ts'));
export const CURRENT_ENV: 'dev' | 'published' = IS_PRODUCTION ? 'published' : 'dev';

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
  private isExplicitlyStopped: boolean = false;

  // Track the last message sent in each channel so each new command deletes the previous one
  private lastChannelMessageIds: Map<string, string> = new Map();

  // Player head emoji cache: playerName.toLowerCase() -> '<:head_name:id>'
  private playerEmojiCache: Map<string, string> = new Map();
  private pendingSelections: Map<string, PendingSession> = new Map();

  constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.client.once('ready', async () => {
      this.isReady = true;
      this.botTag = this.client.user?.tag || 'Aternos Bot';
      this.botId = this.client.user?.id || DISCORD_CLIENT_ID;
      this.lastPing = this.client.ws.ping;
      console.log(`[Discord Bot (${CURRENT_ENV.toUpperCase()})] Ready as ${this.botTag} (${this.botId})`);

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
            console.error('[Slash Command Unhandled]', err);
          });
        } else if (interaction.isStringSelectMenu()) {
          this.handleSelectMenu(interaction).catch(err => {
            console.error('[Select Menu Unhandled]', err);
          });
        }
      } catch (err: any) {
        console.error('[Discord Interaction Event Error]', err);
      }
    });

    this.client.on('error', err => {
      console.error('[Discord Bot Error]', err?.message);
      this.initError = err.message;
    });

    this.client.on('shardError', error => {
      console.warn('[Discord Bot Shard Error]:', error?.message);
    });

    this.client.on('shardDisconnect', (event, shardId) => {
      console.warn(`[Discord Bot Shard ${shardId} Disconnected] Code: ${event.code}`);
      this.isReady = false;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.isExplicitlyStopped) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.isReady && !this.isExplicitlyStopped && DISCORD_BOT_TOKEN) {
        const activeTarget = serverStorage.getBotTarget();
        if (activeTarget === CURRENT_ENV) {
          console.log(`[Discord Bot (${CURRENT_ENV})] Attempting gateway reconnect...`);
          await this.start().catch(() => {});
        }
      }
    }, 5000);
  }

  public async start(): Promise<void> {
    const activeTarget = serverStorage.getBotTarget();
    if (activeTarget !== CURRENT_ENV) {
      console.log(`[Discord Bot] Idle on ${CURRENT_ENV}. Active target is "${activeTarget}". Bot will not connect here.`);
      this.isExplicitlyStopped = true;
      return;
    }

    if (!DISCORD_BOT_TOKEN) {
      console.warn('[Discord Bot] No token provided.');
      return;
    }

    if (this.isReady) {
      console.log(`[Discord Bot (${CURRENT_ENV})] Already running.`);
      return;
    }

    try {
      this.isExplicitlyStopped = false;
      this.initError = null;
      await this.client.login(DISCORD_BOT_TOKEN);
    } catch (err: any) {
      this.initError = err.message;
      console.error(`[Discord Bot (${CURRENT_ENV})] Login failed:`, err?.message);
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
      console.log(`[Discord Bot (${CURRENT_ENV})] Successfully disconnected and stopped.`);
      serverStorage.addDiscordLog({
        user: this.botTag || 'Aternos Bot',
        command: 'STOP',
        serverAddress: 'discord.gateway',
        status: 'warning',
        message: `Bot stopped on ${CURRENT_ENV}`,
      });
    } catch (err: any) {
      console.warn('[Discord Bot] Error during stop:', err?.message);
    }
  }

  public async setTargetMode(target: 'dev' | 'published' | 'disabled'): Promise<void> {
    serverStorage.setBotTarget(target);
    if (target === CURRENT_ENV) {
      console.log(`[Discord Bot] Activating on ${CURRENT_ENV}...`);
      await this.start();
    } else {
      console.log(`[Discord Bot] Deactivating on ${CURRENT_ENV} (target is now ${target})...`);
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

      // Register global commands
      await rest.put(Routes.applicationCommands(targetId), {
        body: commands.map(cmd => cmd.toJSON()),
      });
      console.log('[Discord Bot] Global slash commands registered.');

      // Also register per-guild for instant update in all active guilds
      for (const [guildId] of this.client.guilds.cache) {
        rest.put(Routes.applicationGuildCommands(targetId, guildId), {
          body: commands.map(cmd => cmd.toJSON()),
        }).catch(() => {});
      }
    } catch (err: any) {
      console.warn('[Discord Bot] Slash commands registration notice:', err?.message);
    }
  }

  private resolveServerContext(contextId: string, userId?: string) {
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
        binding,
      };
    }

    // Check if ANY known server is currently ONLINE in aternosService
    const allStates = aternosService.getAllStates();
    const allProfiles = serverStorage.getAllProfiles();
    for (const p of allProfiles) {
      const pCanon = serverStorage.getCanonicalServerAddress(p.serverIp || p.name);
      const st = allStates[pCanon.toLowerCase()] || allStates[p.id];
      if (st && (st.status === 'online' || st.status === 'starting')) {
        return {
          serverAddress: pCanon,
          sessionCookie: p.sessionCookie,
          serverCookie: p.serverCookie,
          profile: p,
        };
      }
    }

    // Check active server configured in aternosService
    const cfg = aternosService.getConfig();
    if (cfg.serverAddress) {
      const canonical = serverStorage.getCanonicalServerAddress(cfg.serverAddress);
      const profile = serverStorage.getProfile(canonical) || serverStorage.getProfile(cfg.serverAddress);
      return {
        serverAddress: canonical,
        sessionCookie: cfg.sessionCookie || profile?.sessionCookie || '',
        serverCookie: cfg.serverCookie || profile?.serverCookie || '',
        profile,
      };
    }

    // Fallback to first available profile
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

  private getPlayerHeadEmoji(playerName: string): string {
    const cleanName = playerName.trim();
    if (!cleanName) return '👤';
    const cacheKey = cleanName.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 26);

    const cached = this.playerEmojiCache.get(cacheKey);
    if (cached) return cached;

    const app = this.client.application as any;
    const emojiName = `bhead_${cacheKey}`;
    const legacyName = `head_${cacheKey}`;
    const found = app?.emojis?.cache?.find((e: any) => e.name === emojiName || e.name === legacyName);
    if (found) {
      const formatted = `<:${found.name}:${found.id}>`;
      this.playerEmojiCache.set(cacheKey, formatted);
      return formatted;
    }

    return '👤';
  }

  // Fast resolution of fresh Aternos + Minecraft live status with strict offline verification
  private async getFastServerState(serverAddress: string, sessionCookie?: string) {
    let state: AternosState = aternosService.getState(serverAddress);

    // Sync from Aternos if older than 3s
    if (sessionCookie || Date.now() - state.lastUpdated > 3000) {
      try {
        const syncTimeout = new Promise<AternosState>(resolve => setTimeout(() => resolve(state), 2000));
        state = await Promise.race([aternosService.syncSessionState(serverAddress), syncTimeout]);
      } catch {}
    }

    // Fast Minecraft server query
    const live = await queryMinecraftServer(
      serverAddress,
      state.dynip,
      state.playersOnline || 0,
      state.playerList || [],
      state.status === 'online' || state.status === 'starting'
    );

    const isLiveOffline = !live?.online || isAternosOfflineIndicator(live?.version, live?.motd);
    const isStateStarting = state.status === 'starting';

    // If server is verified offline or stopping, reset countdown states
    if (state.status === 'offline' || state.status === 'stopping' || (isLiveOffline && state.status !== 'online' && !isStateStarting)) {
      if (isLiveOffline && !isStateStarting) {
        state.countdownActive = false;
        state.countdownSeconds = null;
        state.countdownFormatted = null;
        state.canExtend = false;
        state.playersOnline = 0;
        state.playerList = [];
      }
    }

    return { state, live };
  }

  // Build clean, polished real-time server status diagnostics embed (NO ASCII ART, NO BIG BOT HEAD)
  private buildStatusEmbed(
    serverAddress: string,
    state: any,
    live: any
  ): EmbedBuilder {
    const canonicalAddr = serverStorage.getCanonicalServerAddress(serverAddress);

    // Precise offline/online check
    const isAternosOffline = state.status === 'offline';
    const isStopping = state.status === 'stopping';
    const isStarting = state.status === 'starting';
    const isQueue = state.status === 'queue';
    const isLiveOffline = !live?.online || isAternosOfflineIndicator(live?.version, live?.motd);

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
    } else if (!isAternosOffline && !isLiveOffline && Boolean(live?.online)) {
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

    // Online players list
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

    embed.setFooter({ text: 'Aternos Command Center' });
    embed.setTimestamp();

    return embed;
  }

  // Delete previous bot message in channel before sending a new one
  private async deletePreviousChannelMessage(contextId: string, channel: any) {
    if (!channel) return;

    try {
      // 1. Delete message by tracked ID if known
      const prevMsgId = this.lastChannelMessageIds.get(contextId);
      if (prevMsgId && 'messages' in channel && typeof channel.messages?.fetch === 'function') {
        const oldMsg = await channel.messages.fetch(prevMsgId).catch(() => null);
        if (oldMsg && oldMsg.deletable) {
          await oldMsg.delete().catch(() => {});
        }
      }

      // 2. Sweep recent channel messages to purge any previous messages sent by THIS bot
      if ('messages' in channel && typeof channel.messages?.fetch === 'function') {
        const recent = await channel.messages.fetch({ limit: 12 }).catch(() => null);
        if (recent && recent.size > 0) {
          const myId = this.client.user?.id;
          for (const [, msg] of recent) {
            if (msg.author?.id === myId && msg.id !== prevMsgId && msg.deletable) {
              await msg.delete().catch(() => {});
            }
          }
        }
      }
    } catch {}
  }

  // Handle Slash Command with immediate deferral, previous message deletion, and zero clutter
  private async handleSlashCommand(interaction: ChatInputCommandInteraction) {
    const { commandName, user, guildId, channelId } = interaction;
    const contextId = channelId || guildId || user.id;

    // /configure contains sensitive session cookie, so it remains ephemeral
    const isEphemeral = commandName === 'configure';

    // 1. Immediately defer within 50ms so Discord never shows "Application did not respond"
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: isEphemeral });
      }
    } catch (err: any) {
      console.warn(`[Discord] Could not defer /${commandName}:`, err?.message);
      return;
    }

    // 2. Delete previous bot message in this channel before sending the new one
    if (!isEphemeral && interaction.channel) {
      await this.deletePreviousChannelMessage(contextId, interaction.channel);
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
            serverStorage.setDiscordBinding({
              guildIdOrUserId: contextId,
              serverAddress: canonicalAddr,
              sessionCookie: session,
              serverCookie: matchedServer.serverCookie,
              configuredBy: user.username,
              updatedAt: Date.now(),
            });

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
              .setDescription(`Successfully linked **${canonicalAddr}** to this Discord server.\nYou can now control your server using slash commands.`)
              .addFields(
                { name: '🌐 Server Address', value: `\`${canonicalAddr}\``, inline: true },
                { name: '🔑 Server ID', value: `\`${matchedServer.id}\``, inline: true },
                { name: '🔒 Session Auth', value: '✅ Synced & Active', inline: true },
                {
                  name: '🎮 Control Commands',
                  value: '`/status` — Check online status & player count\n`/players` — View online players\n`/start` — Turn on server\n`/stop` — Turn off server\n`/restart` — Reboot server',
                }
              )
              .setFooter({ text: 'Aternos Command Center' })
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
              );
            await interaction.editReply({ embeds: [embed] });
            return;
          }

          const menuCustomId = `select_srv_${user.id}_${Date.now()}`;
          this.pendingSelections.set(menuCustomId, {
            session,
            servers: discovered,
            contextId,
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
          const ctx = this.resolveServerContext(contextId, user.id);
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
              .setFooter({ text: 'Aternos Command Center' })
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
              .setFooter({ text: 'Aternos Command Center' })
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
              .setFooter({ text: 'Aternos Command Center' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } else {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('❌ Start Command Failed')
              .setDescription(`Aternos rejected the start request:\n\`${res.message}\`\nVerify that your session cookie is valid via \`/configure\`.`)
              .setFooter({ text: 'Aternos Command Center' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          }
          break;
        }

        case 'stop': {
          const ctx = this.resolveServerContext(contextId, user.id);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);

          const isOnline = !isAternosOfflineIndicator(live?.version, live?.motd) && (live?.online || state.status === 'online');

          if (!isOnline && state.status !== 'starting' && state.status !== 'stopping') {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle(`⚠️ ${ctx.serverAddress} is Already Offline!`)
              .setDescription(`Cannot stop a server that isn't running.\nUse \`/start\` if you would like to boot it up.`)
              .setFooter({ text: 'Aternos Command Center' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            break;
          }

          if (state.status === 'stopping') {
            const embed = new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle(`⏳ ${ctx.serverAddress} is Shutting Down!`)
              .setDescription(`Server is already shutting down and saving world files.`)
              .setFooter({ text: 'Aternos Command Center' })
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
              .setFooter({ text: 'Aternos Command Center' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } else {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('❌ Stop Command Failed')
              .setDescription(`Aternos returned: \`${res.message}\``)
              .setFooter({ text: 'Aternos Command Center' })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          }
          break;
        }

        case 'restart': {
          const ctx = this.resolveServerContext(contextId, user.id);

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
            .setFooter({ text: 'Aternos Command Center' })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
          break;
        }

        case 'status': {
          const ctx = this.resolveServerContext(contextId, user.id);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);

          const embed = this.buildStatusEmbed(ctx.serverAddress, state, live);
          await interaction.editReply({ embeds: [embed] });
          break;
        }

        case 'players': {
          const ctx = this.resolveServerContext(contextId, user.id);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);

          const isAternosOffline = state.status === 'offline';
          const isStopping = state.status === 'stopping';
          const isStarting = state.status === 'starting';
          const isLiveOffline = !live?.online || isAternosOfflineIndicator(live?.version, live?.motd);
          const isOnline = !isAternosOffline && !isStopping && !isStarting && !isLiveOffline && Boolean(live?.online);

          if (!isOnline) {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle(`🔴 Server is Offline`)
              .setDescription(`**${ctx.serverAddress}** is currently offline. Active players cannot be queried.\nUse \`/start\` to bring the server online!`)
              .setFooter({ text: 'Aternos Command Center' })
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
              .setFooter({ text: 'Aternos Command Center' })
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
            .setFooter({ text: 'Aternos Command Center' })
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

      // Record sent message ID for this channel so the next command deletes it
      if (!isEphemeral) {
        const reply = await interaction.fetchReply().catch(() => null);
        if (reply && reply.id) {
          this.lastChannelMessageIds.set(contextId, reply.id);
          if (channelId) this.lastChannelMessageIds.set(channelId, reply.id);
        }
      }
    } catch (err: any) {
      if (err?.code === 10008 || err?.message?.includes('Unknown Message')) {
        return;
      }
      console.error(`[Discord /${commandName} Error]`, err);
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
      console.warn('[Discord] Could not defer select menu:', err?.message);
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
        .setDescription(`Successfully linked **${canonicalAddr}** (ID: \`${chosenServer.id}\`) to this Discord server.\nYou can now control your server directly!`)
        .addFields(
          { name: '🌐 Server Address', value: `\`${canonicalAddr}\``, inline: true },
          { name: '🔑 Server ID', value: `\`${chosenServer.id}\``, inline: true },
          { name: '🔒 Session Auth', value: '✅ Synced & Active', inline: true },
          {
            name: '🎮 Control Commands',
            value: '`/status` — Check online status & player count\n`/players` — View online players\n`/start` — Turn on server\n`/stop` — Turn off server\n`/restart` — Reboot server',
          }
        )
        .setFooter({ text: 'Aternos Command Center' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], components: [] });
      this.pendingSelections.delete(customId);
    } catch (err: any) {
      console.error('[Select Menu Error]', err);
    }
  }

  public getBotStatus() {
    return {
      isReady: this.isReady,
      currentEnv: CURRENT_ENV,
      activeTarget: serverStorage.getBotTarget(),
      botTag: this.botTag || (this.isReady ? 'Aternos#3859' : 'Disconnected'),
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
