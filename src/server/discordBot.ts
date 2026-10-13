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
import sharp from 'sharp';
import { aternosService } from './aternosAutomation.ts';
import type { AternosState } from '../types/aternos.ts';
import { serverStorage } from './serverStorage.ts';
import { queryMinecraftServer } from './mcPing.ts';

const DISCORD_BOT_TOKEN =
  process.env.DISCORD_BOT_TOKEN ||
  'MTU1NTMzMDg1Njc1Nzc1NTk5NA.GLEqGe.jXMPh6b0PV8HEOB0sKBRbGTkOTBxgGmiX3tSOQ';
const DISCORD_CLIENT_ID = '1555330856757755994';

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

  // Player head emoji cache: playerName.toLowerCase() -> '<:head_name:id>'
  private playerEmojiCache: Map<string, string> = new Map();
  private canCreateApplicationEmojis: boolean = true;
  private emojiQueue: string[] = [];
  private isProcessingEmojiQueue: boolean = false;

  // Pending server selections for /configure
  private pendingSelections: Map<string, PendingSession> = new Map();

  // Track previous interactions per user to delete older messages when a new command is run
  private userLastInteractions: Map<string, { interaction: any; timestamp: number }[]> = new Map();

  constructor() {
    // ONLY Guilds intent — no message content or message events needed
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
      ],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.client.once('ready', async () => {
      this.isReady = true;
      this.botTag = this.client.user?.tag || 'Aternos Bot';
      this.botId = this.client.user?.id || DISCORD_CLIENT_ID;
      this.lastPing = this.client.ws.ping;
      console.log(`[Discord Bot] Ready as ${this.botTag} (${this.botId})`);

      serverStorage.addDiscordLog({
        user: this.botTag,
        command: 'READY',
        serverAddress: 'discord.gateway',
        status: 'success',
        message: `Connected in ${this.client.guilds.cache.size} server(s)`,
      });

      // Preload application emojis into cache for 0ms lookup
      await this.loadExistingApplicationEmojis();

      // Register clean slash commands (no optional address parameter)
      await this.registerSlashCommands();
    });

    // Interaction handler (ONLY Slash Commands & Select Menus - NO ! commands)
    this.client.on('interactionCreate', async interaction => {
      try {
        if (interaction.isChatInputCommand()) {
          // Fire non-blocking so simultaneous commands never stall each other
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
  }

  public async start(): Promise<void> {
    if (!DISCORD_BOT_TOKEN) return;
    try {
      await this.client.login(DISCORD_BOT_TOKEN);
    } catch (err: any) {
      this.initError = err.message;
      console.error('[Discord Bot] Login failed:', err?.message);
    }
  }

  // Pre-fetch all application emojis at startup so lookups are 0ms in-memory
  private async loadExistingApplicationEmojis(): Promise<void> {
    try {
      const app = this.client.application as any;
      if (!app?.emojis) return;

      const emojis = await app.emojis.fetch().catch(() => null);
      if (emojis) {
        emojis.forEach((e: any) => {
          if (e.name) {
            const cleanKey = e.name.toLowerCase().replace(/^head_/, '');
            this.playerEmojiCache.set(cleanKey, `<:${e.name}:${e.id}>`);
          }
        });
        console.log(`[Discord Bot] Loaded ${emojis.size} pre-existing application head emojis into memory cache.`);
      }
    } catch (err: any) {
      console.warn('[Discord Bot] Could not preload application emojis:', err?.message);
    }
  }

  // Register Clean Slash Commands WITHOUT optional server address parameter
  private async registerSlashCommands() {
    const commands = [
      new SlashCommandBuilder()
        .setName('configure')
        .setDescription('Link your Aternos server with your session')
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
        .setDescription('Check server status, online players, and port details'),

      new SlashCommandBuilder()
        .setName('players')
        .setDescription('View connected players and their small avatars'),
    ];

    try {
      const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
      await rest.put(Routes.applicationCommands(this.botId || DISCORD_CLIENT_ID), {
        body: commands.map(cmd => cmd.toJSON()),
      });
      console.log('[Discord Bot] Clean slash commands registered successfully.');
    } catch (err: any) {
      console.warn('[Discord Bot] Slash commands notice:', err?.message);
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

    // Next, check active server configured in aternosService
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

  // Instant 0ms synchronous head emoji lookup.
  // Never blocks, never stalls commands, never causes Discord rate limit issues.
  // If emoji exists in memory, returns <:head_name:id>.
  // If not, returns 👤 immediately and queues background creation.
  private getPlayerHeadEmoji(playerName: string): string {
    const cleanName = playerName.trim();
    if (!cleanName) return '👤';
    const cacheKey = cleanName.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 26);

    // 1. Direct hit in memory cache
    const cached = this.playerEmojiCache.get(cacheKey);
    if (cached) return cached;

    // 2. Check Discord client application emoji cache
    const app = this.client.application as any;
    const emojiName = `head_${cacheKey}`;
    const found = app?.emojis?.cache?.find((e: any) => e.name === emojiName);
    if (found) {
      const formatted = `<:${found.name}:${found.id}>`;
      this.playerEmojiCache.set(cacheKey, formatted);
      return formatted;
    }

    // 3. Queue non-blocking background creation (throttled, isolated)
    this.queueBackgroundEmojiCreation(cleanName);

    return '👤';
  }

  // Queue background head creation so it NEVER slows down user interactions
  private queueBackgroundEmojiCreation(playerName: string) {
    if (!this.canCreateApplicationEmojis) return;
    const cleanKey = playerName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 26);
    if (this.playerEmojiCache.has(cleanKey)) return;
    if (this.emojiQueue.includes(playerName)) return;

    this.emojiQueue.push(playerName);
    this.processEmojiQueue();
  }

  private async processEmojiQueue() {
    if (this.isProcessingEmojiQueue || this.emojiQueue.length === 0) return;
    this.isProcessingEmojiQueue = true;

    try {
      while (this.emojiQueue.length > 0) {
        const nextName = this.emojiQueue.shift();
        if (!nextName) continue;

        const cleanKey = nextName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 26);
        if (this.playerEmojiCache.has(cleanKey)) continue;

        await this.createHeadEmojiInBackground(nextName, cleanKey);

        // Throttle 1500ms between creations to completely respect Discord REST limits
        await new Promise(r => setTimeout(r, 1500));
      }
    } finally {
      this.isProcessingEmojiQueue = false;
    }
  }

  private async createHeadEmojiInBackground(cleanName: string, cacheKey: string): Promise<void> {
    try {
      const app = this.client.application as any;
      if (!app?.emojis) return;

      const emojiName = `head_${cacheKey}`;
      let appEmojis = app.emojis.cache;
      if (!appEmojis || appEmojis.size === 0) {
        appEmojis = await app.emojis.fetch().catch(() => null);
      }

      const existing = appEmojis?.find((e: any) => e.name === emojiName);
      if (existing) {
        this.playerEmojiCache.set(cacheKey, `<:${existing.name}:${existing.id}>`);
        return;
      }

      // If near limit of 50 emojis, delete oldest head_ emoji
      if (appEmojis && appEmojis.size >= 48) {
        const oldest = appEmojis.find((e: any) => e.name?.startsWith('head_'));
        if (oldest) {
          await oldest.delete().catch(() => {});
        }
      }

      const candidateUrls = [
        `https://mc-heads.net/avatar/${encodeURIComponent(cleanName)}/64`,
        `https://crafthead.net/helm/${encodeURIComponent(cleanName)}/64`,
        `https://minotar.net/helm/${encodeURIComponent(cleanName)}/64.png`,
      ];

      let imageBuf: Buffer | null = null;
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
        } catch {}
      }

      if (!imageBuf) return;

      const size = 64;
      const radius = 16;
      const roundedCornersSvg = Buffer.from(
        `<svg><rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}"/></svg>`
      );
      const roundedBuf = await sharp(imageBuf)
        .resize(size, size)
        .composite([{ input: roundedCornersSvg, blend: 'dest-in' }])
        .png()
        .toBuffer();

      const created = await app.emojis.create({
        attachment: roundedBuf,
        name: emojiName,
      });

      if (created) {
        this.playerEmojiCache.set(cacheKey, `<:${created.name}:${created.id}>`);
      }
    } catch (err: any) {
      if (err?.code === 30008 || err?.status === 403) {
        this.canCreateApplicationEmojis = false;
      }
    }
  }

  // Build real-time server status diagnostics embed
  // Shows small player heads for players, NO big player head thumbnail!
  private buildStatusEmbed(serverAddress: string, state: any, live: any): EmbedBuilder {
    const canonicalAddr = serverStorage.getCanonicalServerAddress(serverAddress);
    const isOnline = state.status === 'online' || live?.online;
    const statusText = isOnline
      ? '🟢 Online'
      : state.status === 'starting'
      ? '🟡 Starting'
      : state.status === 'queue'
      ? '⏳ In Queue'
      : '🔴 Offline';

    const color = isOnline ? 0x10b981 : state.status === 'starting' ? 0xf59e0b : 0xef4444;
    const playerCount = Math.max(live?.players?.online || 0, state.playersOnline || 0);
    const maxCount = live?.players?.max || state.maxPlayers || 20;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`🎮 Minecraft Server Diagnostics`)
      .setDescription(`Live status for **${canonicalAddr}**:`)
      .addFields(
        { name: 'Status', value: `**${statusText}**`, inline: true },
        { name: 'Players Online', value: `\`${playerCount}/${maxCount}\` active`, inline: true },
        { name: 'Server Address', value: `\`${canonicalAddr}:${state.serverPort || 25565}\``, inline: true }
      );

    if (state.dynip) {
      embed.addFields({ name: 'Direct Connect IP', value: `\`${state.dynip}\``, inline: true });
    }

    if (state.software || live?.version) {
      embed.addFields({
        name: 'Version & Software',
        value: `${state.software || 'Fabric'} ${live?.version || state.version || '1.20.4'}`,
        inline: true,
      });
    }

    // Active players list with small player heads (NO big thumbnail)
    const playerNames: string[] = [];
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

    if (state.motd || live?.motd) {
      embed.addFields({
        name: '📜 MOTD',
        value: `*${state.motd || live?.motd}*`,
        inline: false,
      });
    }

    if (isOnline) {
      if (playerCount === 0) {
        const secs = state.countdownSeconds ?? 360;
        const mins = Math.floor(secs / 60);
        const s = secs % 60;
        const formatted = state.countdownFormatted || `${mins}:${s < 10 ? '0' : ''}${s}`;
        const targetEpoch = Math.floor(Date.now() / 1000) + secs;

        embed.addFields({
          name: '⏱️ Keepalive Timer',
          value: `\`${formatted}\` remaining • Auto-shutdown <t:${targetEpoch}:R>\n*(Synced with Aternos dashboard)*`,
          inline: false,
        });
      } else {
        embed.addFields({
          name: '⏱️ Keepalive Timer',
          value: `🟢 **Paused** (${playerCount} active player${playerCount > 1 ? 's' : ''} connected)`,
          inline: false,
        });
      }
    }

    // Set bot icon only in footer (NO big thumbnail)
    embed.setFooter({ text: 'Aternos Command Center', iconURL: this.client.user?.displayAvatarURL() });
    embed.setTimestamp();

    return embed;
  }

  // Fast resolution of fresh Aternos + Minecraft live status with concurrency protection
  private async getFastServerState(serverAddress: string, sessionCookie?: string) {
    let state: AternosState = aternosService.getState(serverAddress);

    // Sync from Aternos if offline or older than 3.5s, with strict 2500ms max timeout so Discord never lags
    if (sessionCookie && (state.status === 'offline' || Date.now() - state.lastUpdated > 3500)) {
      try {
        const syncTimeout = new Promise<AternosState>(resolve => setTimeout(() => resolve(state), 2500));
        state = await Promise.race([aternosService.syncSessionState(serverAddress), syncTimeout]);
      } catch {}
    }

    const live = await queryMinecraftServer(
      serverAddress,
      state.dynip,
      state.playersOnline || 0,
      state.playerList || [],
      state.status === 'online' || state.status === 'starting'
    );

    return { state, live };
  }

  // Clean up previous bot messages for the user so each new command replaces the old message
  private async deleteUserPreviousMessages(userId: string, currentInteraction: ChatInputCommandInteraction) {
    // 1. Delete previous interaction reply for this user (both ephemeral and public)
    const prevList = this.userLastInteractions.get(userId) || [];
    for (const item of prevList) {
      if (item.interaction && item.interaction.id !== currentInteraction.id) {
        try {
          if (Date.now() - item.timestamp < 14 * 60 * 1000) {
            await item.interaction.deleteReply().catch(() => {});
          }
        } catch {}
      }
    }

    // Retain only the current interaction for this user
    this.userLastInteractions.set(userId, [
      { interaction: currentInteraction, timestamp: Date.now() },
    ]);

    // 2. Also check if there are any lingering public messages sent by the bot in this channel and delete them
    try {
      const channel = currentInteraction.channel;
      if (channel && 'messages' in channel && typeof (channel as any).messages?.fetch === 'function') {
        const fetched = await (channel as any).messages.fetch({ limit: 10 }).catch(() => null);
        if (fetched) {
          const botMessages = fetched.filter((m: any) => m.author?.id === this.client.user?.id);
          for (const [, msg] of botMessages) {
            await msg.delete().catch(() => {});
          }
        }
      }
    } catch {}
  }

  // Handle Slash Command with complete concurrency and rate limit protection
  private async handleSlashCommand(interaction: ChatInputCommandInteraction) {
    const { commandName, user, guildId, channelId } = interaction;
    const contextId = guildId || channelId || user.id;

    // Immediately defer interaction with ephemeral: true so ALL messages the bot sends
    // are sent privately to the user who invoked the command ("Only you can see this").
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
      }
    } catch (err: any) {
      console.warn(`[Discord] Could not defer /${commandName}:`, err?.message);
      return;
    }

    // Automatically delete the previous message the bot sent to this user so old messages don't stack up
    await this.deleteUserPreviousMessages(user.id, interaction);

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
              .setFooter({ text: 'Aternos Command Center', iconURL: this.client.user?.displayAvatarURL() })
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

          if (state.status === 'online' || live.online) {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('⚠️ Server is Already Online!')
              .setDescription(`**${ctx.serverAddress}** is already online and running. You cannot start a server that is currently active.`)
              .addFields(
                { name: 'Status', value: '🟢 **Online**', inline: true },
                { name: 'Players', value: `\`${live.players.online}/${live.players.max}\``, inline: true },
                { name: 'Tip', value: 'Use `/stop` to shut it down, or `/restart` to reboot.', inline: false }
              );
            await interaction.editReply({ embeds: [embed] });
            return;
          }

          if (state.status === 'starting' || state.status === 'queue') {
            const embed = new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle('⏳ Server is Currently Booting Up!')
              .setDescription(`**${ctx.serverAddress}** is already in the starting sequence. Please give it 1 to 2 minutes to load world data.`)
              .addFields({ name: 'Current Status', value: `🟡 ${state.rawStatus || 'Starting ...'}` });
            await interaction.editReply({ embeds: [embed] });
            return;
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
              .setTitle('🚀 Server Boot Sequence Initiated')
              .setDescription(`Start signal dispatched to Aternos for **${ctx.serverAddress}**.\nThe server is now starting up and will be ready for players in ~1-2 minutes.`)
              .addFields(
                { name: 'Status', value: '🟡 **Starting ...**', inline: true },
                { name: 'Estimated Time', value: '~60-90 seconds', inline: true },
                { name: 'Tip', value: 'Run `/status` in a moment to track startup progress.', inline: false }
              )
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } else {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('❌ Start Command Failed')
              .setDescription(`Aternos rejected the start request:\n\`${res.message}\`\nVerify that your session cookie is valid via \`/configure\`.`);
            await interaction.editReply({ embeds: [embed] });
          }
          break;
        }

        case 'stop': {
          const ctx = this.resolveServerContext(contextId, user.id);
          const { state, live } = await this.getFastServerState(ctx.serverAddress, ctx.sessionCookie);

          if (state.status === 'offline' && !live.online) {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('⚠️ Server is Already Offline!')
              .setDescription(`**${ctx.serverAddress}** is already turned off. Cannot stop a server that isn't running.`)
              .addFields({ name: 'Tip', value: 'Use `/start` if you would like to boot it up.' });
            await interaction.editReply({ embeds: [embed] });
            return;
          }

          if (state.status === 'stopping') {
            const embed = new EmbedBuilder()
              .setColor(0xf59e0b)
              .setTitle('⏳ Server is Already Shutting Down!')
              .setDescription(`**${ctx.serverAddress}** is already in the shutdown sequence. Please wait while world files are saved.`);
            await interaction.editReply({ embeds: [embed] });
            return;
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
              .setTitle('🛑 Server Shutdown Initiated')
              .setDescription(`Stop signal successfully sent to Aternos for **${ctx.serverAddress}**.\nWorld progress is being saved and the server is powering down safely.`)
              .addFields({ name: 'Status', value: '🟠 **Stopping ...**', inline: true })
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } else {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('❌ Stop Command Failed')
              .setDescription(`Aternos returned: \`${res.message}\``);
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
            .setTitle(res.success ? '🔄 Server Reboot Triggered' : '❌ Restart Failed')
            .setDescription(`Restart signal sent to Aternos for **${ctx.serverAddress}**.\nThe server will cycle off and boot back up automatically.`)
            .addFields({ name: 'Result', value: res.message });

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

          const isOnline = live.online || state.status === 'online' || state.status === 'starting';

          if (!isOnline) {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('🔴 Server is Offline')
              .setDescription(`Cannot fetch active players because **${ctx.serverAddress}** is currently offline.\nUse \`/start\` to bring the server online.`);
            await interaction.editReply({ embeds: [embed] });
            return;
          }

          // Combine unique players from live SLP query and Aternos playerList
          const playerNames = new Set<string>();
          for (const p of (live.players?.list || [])) {
            if (p?.name) playerNames.add(p.name);
          }
          for (const name of (state.playerList || [])) {
            if (name) playerNames.add(name);
          }

          const combinedList = Array.from(playerNames);
          const count = Math.max(combinedList.length, live.players?.online || 0, state.playersOnline || 0);
          const max = live.players?.max || state.maxPlayers || 20;

          if (count === 0 && combinedList.length === 0) {
            const embed = new EmbedBuilder()
              .setColor(0x71717a)
              .setTitle(`👥 No Players Online (0/${max})`)
              .setDescription(`There are currently 0 players connected to **${ctx.serverAddress}**.\nThe world is quiet and waiting for players to join.`);

            if (isOnline) {
              const secs = state.countdownSeconds ?? 360;
              const mins = Math.floor(secs / 60);
              const s = secs % 60;
              const formatted = state.countdownFormatted || `${mins}:${s < 10 ? '0' : ''}${s}`;
              const targetEpoch = Math.floor(Date.now() / 1000) + secs;

              embed.addFields({
                name: '⏱️ Keepalive Timer',
                value: `\`${formatted}\` remaining • Auto-shutdown <t:${targetEpoch}:R>\n*(Synced with Aternos dashboard)*`,
                inline: false,
              });
            }

            embed.setFooter({ text: 'Aternos Command Center', iconURL: this.client.user?.displayAvatarURL() });
            embed.setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            return;
          }

          const embed = new EmbedBuilder()
            .setColor(0x10b981)
            .setTitle(`👥 Online Players (${count}/${max})`)
            .setDescription(`Active players currently connected to **${ctx.serverAddress}**:`)
            .setTimestamp();

          if (combinedList.length > 0) {
            // Render clean player lines with small player heads, NO skin links, NO big head thumbnail
            const playerLines = combinedList.map((name, idx) => {
              const headEmoji = this.getPlayerHeadEmoji(name);
              return `**${idx + 1}.** ${headEmoji} **${name}**`;
            });
            embed.addFields({ name: 'Connected Players', value: playerLines.join('\n'), inline: false });
          } else {
            embed.setDescription(`There ${count === 1 ? 'is' : 'are'} currently **${count}** player${count > 1 ? 's' : ''} connected to the server.`);
          }

          embed.setFooter({
            text: 'Aternos Command Center',
            iconURL: this.client.user?.displayAvatarURL(),
          });

          await interaction.editReply({ embeds: [embed] });
          break;
        }

        default:
          await interaction.editReply({ content: 'Unknown command.' });
      }
    } catch (err: any) {
      // If error is because the message was already deleted (e.g. replaced by newer command), ignore silently
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
    const { customId, values, user } = interaction;
    const pending = this.pendingSelections.get(customId);

    if (!pending) {
      await interaction.reply({
        content: '⚠️ This server selection menu has expired. Please run `/configure` again.',
        ephemeral: true,
      });
      return;
    }

    const selectedId = values[0];
    const chosenServer = pending.servers.find(s => s.id === selectedId);

    if (!chosenServer) {
      await interaction.reply({
        content: '⚠️ Selected server was not found.',
        ephemeral: true,
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
        .setFooter({ text: 'Aternos Command Center', iconURL: this.client.user?.displayAvatarURL() })
        .setTimestamp();

      // Update interaction with no more dropdown components
      await interaction.editReply({ embeds: [embed], components: [] });
      this.pendingSelections.delete(customId);

      // Track completed selection interaction so subsequent command replaces/deletes it
      this.userLastInteractions.set(user.id, [
        { interaction, timestamp: Date.now() },
      ]);
    } catch (err: any) {
      console.error('[Select Menu Error]', err);
    }
  }

  public getBotStatus() {
    return {
      isReady: this.isReady,
      botTag: this.botTag || (this.isReady ? 'Aternos#3859' : 'Connecting...'),
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
