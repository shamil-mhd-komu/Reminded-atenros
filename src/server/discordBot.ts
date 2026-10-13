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
  type Message,
} from 'discord.js';
import sharp from 'sharp';
import { aternosService } from './aternosAutomation.ts';
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

  // Track previous interactions and messages to auto-delete old bot responses
  private lastUserInteractions: Map<string, ChatInputCommandInteraction> = new Map();
  private lastUserMessages: Map<string, Message> = new Map();

  // Player head emoji cache: playerName.toLowerCase() -> '<:head_name:id>'
  private playerEmojiCache: Map<string, string> = new Map();
  // Sequential queue for emoji creation to prevent rate limits
  private emojiQueue: Promise<void> = Promise.resolve();

  // Active live ticker updaters for status countdown
  private activeTickers: Map<string, { interval: NodeJS.Timeout; stop: () => void }> = new Map();

  // Pending server selections for /configure
  private pendingSelections: Map<string, PendingSession> = new Map();

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
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

      await this.registerSlashCommands();
    });

    // Interaction handler (Slash Commands & Select Menus)
    this.client.on('interactionCreate', async interaction => {
      if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction);
      } else if (interaction.isStringSelectMenu()) {
        await this.handleSelectMenu(interaction);
      }
    });

    // Message Prefix Handler (!status, !start, etc.)
    this.client.on('messageCreate', async message => {
      if (message.author.bot) return;
      await this.handleMessageFallback(message);
    });

    this.client.on('error', err => {
      console.error('[Discord Bot Error]', err);
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

  // Register clean Slash Commands with NO optional address options
  private async registerSlashCommands() {
    const commands = [
      new SlashCommandBuilder()
        .setName('configure')
        .setDescription('Link your Aternos server with your session')
        .addStringOption(o => o.setName('session').setDescription('Aternos session cookie').setRequired(true))
        .addStringOption(o => o.setName('server').setDescription('Optional server ID (leave empty to pick from list)').setRequired(false)),

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
        .setDescription('View connected players and their skin head avatars'),
    ];

    try {
      const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
      await rest.put(Routes.applicationCommands(this.botId || DISCORD_CLIENT_ID), {
        body: commands.map(cmd => cmd.toJSON()),
      });
      console.log('[Discord Bot] Global slash commands registered (clean parameters).');
    } catch (err: any) {
      console.warn('[Discord Bot] Slash commands notice:', err?.message);
    }
  }

  private resolveServerContext(contextId: string, userId?: string) {
    let binding = serverStorage.getDiscordBinding(contextId);
    if (!binding && userId) {
      binding = serverStorage.getDiscordBinding(userId);
    }
    if (!binding) {
      const allBindings = serverStorage.getAllDiscordBindings();
      if (allBindings.length > 0) {
        binding = allBindings[0];
      }
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

    const all = serverStorage.getAllProfiles();
    const discordProfile = all.find(p => p.source === 'discord') || all[0];
    if (discordProfile) {
      const canonical = serverStorage.getCanonicalServerAddress(discordProfile.serverIp);
      return {
        serverAddress: canonical,
        sessionCookie: discordProfile.sessionCookie,
        serverCookie: discordProfile.serverCookie,
        profile: discordProfile,
      };
    }

    const cfg = aternosService.getConfig();
    const canonical = serverStorage.getCanonicalServerAddress(cfg.serverAddress || 'Bang_Bros_SMP.aternos.me');
    return {
      serverAddress: canonical,
      sessionCookie: cfg.sessionCookie || '',
      serverCookie: cfg.serverCookie || '',
    };
  }

  // Deletes previous bot messages for this user in interaction or channel and clears tickers
  private async clearPreviousBotMessages(userId: string, channel: any) {
    const runningTicker = this.activeTickers.get(userId);
    if (runningTicker) {
      runningTicker.stop();
      this.activeTickers.delete(userId);
    }

    const prevInteraction = this.lastUserInteractions.get(userId);
    if (prevInteraction) {
      try {
        await prevInteraction.deleteReply();
      } catch {}
      this.lastUserInteractions.delete(userId);
    }

    const prevMessage = this.lastUserMessages.get(userId);
    if (prevMessage) {
      try {
        await prevMessage.delete();
      } catch {}
      this.lastUserMessages.delete(userId);
    }

    if (channel && 'messages' in channel && typeof channel.messages.fetch === 'function') {
      try {
        const recent = await channel.messages.fetch({ limit: 10 });
        const botMsgs = recent.filter((m: Message) => m.author.id === this.client.user?.id);
        for (const msg of botMsgs.values()) {
          if (Date.now() - msg.createdTimestamp < 900000) {
            await msg.delete().catch(() => {});
          }
        }
      } catch {}
    }
  }

  // Get or dynamically create small Minecraft player head emoji with rounded corners
  private async getPlayerHeadEmoji(playerName: string): Promise<string> {
    const cleanName = playerName.trim();
    if (!cleanName) return '👤';
    const cacheKey = cleanName.toLowerCase();
    if (this.playerEmojiCache.has(cacheKey)) {
      return this.playerEmojiCache.get(cacheKey)!;
    }

    return new Promise((resolve) => {
      this.emojiQueue = this.emojiQueue.then(async () => {
        try {
          const res = await this.resolvePlayerEmojiInternal(cleanName);
          resolve(res);
        } catch {
          resolve('👤');
        }
      });
    });
  }

  private async resolvePlayerEmojiInternal(cleanName: string): Promise<string> {
    const cacheKey = cleanName.toLowerCase();
    if (this.playerEmojiCache.has(cacheKey)) {
      return this.playerEmojiCache.get(cacheKey)!;
    }

    // Format safe emoji name: only lowercase alphanumeric and underscores, max 26 chars
    const emojiName = `head_${cleanName.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 26)}`;

    try {
      const app = this.client.application as any;
      if (!app) return '👤';

      // Check existing application emojis cache
      let appEmojis = app.emojis?.cache;
      if (!appEmojis || appEmojis.size === 0) {
        appEmojis = await app.emojis?.fetch();
      }

      const existing = appEmojis?.find((e: any) => e.name === emojiName);
      if (existing) {
        const formatted = `<:${existing.name}:${existing.id}>`;
        this.playerEmojiCache.set(cacheKey, formatted);
        return formatted;
      }

      if (app.emojis) {
        // If approaching Discord's 50 application emoji limit, prune oldest head emoji
        if (appEmojis && appEmojis.size >= 48) {
          const oldest = appEmojis.find((e: any) => e.name?.startsWith('head_'));
          if (oldest) {
            await oldest.delete().catch(() => {});
          }
        }

        // Multiple skin lookup candidates (handles Bedrock prefixes, 3D helmets & overlays)
        const strippedName = cleanName.replace(/^[.*_]/, '');
        const candidateUrls = [
          `https://mc-heads.net/avatar/${encodeURIComponent(cleanName)}/64`,
          `https://crafthead.net/helm/${encodeURIComponent(cleanName)}/64`,
          ...(strippedName !== cleanName
            ? [
                `https://mc-heads.net/avatar/${encodeURIComponent(strippedName)}/64`,
                `https://crafthead.net/helm/${encodeURIComponent(strippedName)}/64`,
              ]
            : []),
          `https://minotar.net/helm/${encodeURIComponent(cleanName)}/64.png`,
        ];

        let imageBuf: Buffer | null = null;
        for (const url of candidateUrls) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              const arrayBuf = await res.arrayBuffer();
              if (arrayBuf.byteLength > 200) {
                imageBuf = Buffer.from(arrayBuf);
                break;
              }
            }
          } catch {}
        }

        if (!imageBuf) {
          return '👤';
        }

        // Apply smooth rounded corners with sharp (anti-aliased transparent edges)
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

        const formatted = `<:${created.name}:${created.id}>`;
        this.playerEmojiCache.set(cacheKey, formatted);

        // Small delay to prevent Discord REST burst rate limiting on next player
        await new Promise(r => setTimeout(r, 600));
        return formatted;
      }
    } catch (err: any) {
      console.warn(`[Discord Bot] Could not create head emoji for ${cleanName}:`, err?.message);
    }

    return '👤';
  }

  // Build real-time server status diagnostics embed
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
        value: `${state.software || 'Paper'} ${live?.version || state.version || '1.20.4'}`,
        inline: true,
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
          value: `\`${formatted}\` remaining • Auto-shutdown <t:${targetEpoch}:R>\n*(Updated live like in Aternos dashboard)*`,
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

    embed.setFooter({ text: 'Aternos Command Center', iconURL: this.client.user?.displayAvatarURL() });
    embed.setTimestamp();

    return embed;
  }

  // Start real-time live ticker editing status message smoothly every 1.5 seconds like in Aternos dashboard
  private startStatusLiveTicker(
    key: string,
    serverAddress: string,
    target: ChatInputCommandInteraction | Message
  ) {
    if (this.activeTickers.has(key)) {
      this.activeTickers.get(key)!.stop();
    }

    let isUpdating = false;
    let lastFormatted = '';
    const startTime = Date.now();
    let tickCount = 0;
    const canonicalAddr = serverStorage.getCanonicalServerAddress(serverAddress);

    const interval = setInterval(async () => {
      // Auto-stop after 10 minutes (Discord interaction tokens expire after 15 minutes)
      if (Date.now() - startTime > 10 * 60 * 1000) {
        clearInterval(interval);
        this.activeTickers.delete(key);
        return;
      }

      if (isUpdating) return;
      isUpdating = true;
      tickCount++;

      try {
        const state = aternosService.getState(canonicalAddr);

        // Periodically verify live ping every 15 seconds without stalling the ticker
        let live: any = null;
        if (tickCount % 10 === 0) {
          live = await queryMinecraftServer(canonicalAddr, state.dynip, state.playersOnline || 0);
        }

        const isOnline = state.status === 'online' || (live && live.online);
        const count = Math.max(live?.players?.online || 0, state.playersOnline || 0);

        // If server stopped or players joined, perform one final update and stop ticker
        if (!isOnline || count > 0) {
          const finalEmbed = this.buildStatusEmbed(canonicalAddr, state, live);
          if ('editReply' in target) {
            await target.editReply({ embeds: [finalEmbed] });
          } else {
            await target.edit({ embeds: [finalEmbed] });
          }
          clearInterval(interval);
          this.activeTickers.delete(key);
          return;
        }

        const currentFormatted = state.countdownFormatted || '';
        if (currentFormatted === lastFormatted && state.countdownSeconds !== null && tickCount % 10 !== 0) {
          isUpdating = false;
          return;
        }
        lastFormatted = currentFormatted;

        const embed = this.buildStatusEmbed(canonicalAddr, state, live);

        if ('editReply' in target) {
          await target.editReply({ embeds: [embed] });
        } else {
          await target.edit({ embeds: [embed] });
        }
      } catch (err: any) {
        if (err?.code === 10008 || err?.code === 10015 || err?.code === 10062) {
          clearInterval(interval);
          this.activeTickers.delete(key);
        }
      } finally {
        isUpdating = false;
      }
    }, 1500);

    this.activeTickers.set(key, {
      interval,
      stop: () => {
        clearInterval(interval);
        this.activeTickers.delete(key);
      },
    });
  }

  // Start real-time live ticker for /players when 0 players are on
  private startPlayersLiveTicker(
    key: string,
    serverAddress: string,
    target: ChatInputCommandInteraction | Message,
    max: number
  ) {
    if (this.activeTickers.has(key)) {
      this.activeTickers.get(key)!.stop();
    }

    let isUpdating = false;
    let lastFormatted = '';
    const startTime = Date.now();
    const canonicalAddr = serverStorage.getCanonicalServerAddress(serverAddress);

    const interval = setInterval(async () => {
      if (Date.now() - startTime > 10 * 60 * 1000) {
        clearInterval(interval);
        this.activeTickers.delete(key);
        return;
      }

      if (isUpdating) return;
      isUpdating = true;

      try {
        const state = aternosService.getState(canonicalAddr);
        const count = state.playersOnline || 0;

        if (state.status !== 'online' || count > 0) {
          clearInterval(interval);
          this.activeTickers.delete(key);
          return;
        }

        const currentFormatted = state.countdownFormatted || '';
        if (currentFormatted === lastFormatted && state.countdownSeconds !== null) {
          isUpdating = false;
          return;
        }
        lastFormatted = currentFormatted;

        const secs = state.countdownSeconds ?? 360;
        const mins = Math.floor(secs / 60);
        const s = secs % 60;
        const formatted = state.countdownFormatted || `${mins}:${s < 10 ? '0' : ''}${s}`;
        const targetEpoch = Math.floor(Date.now() / 1000) + secs;

        const embed = new EmbedBuilder()
          .setColor(0x71717a)
          .setTitle(`👥 No Players Online (0/${max})`)
          .setDescription(`There are currently 0 players connected to **${canonicalAddr}**.\nThe world is quiet and waiting for players to join.`)
          .addFields({
            name: '⏱️ Keepalive Timer',
            value: `\`${formatted}\` remaining • Auto-shutdown <t:${targetEpoch}:R>\n*(Updated live like in Aternos dashboard)*`,
            inline: false,
          })
          .setFooter({ text: 'Aternos Command Center', iconURL: this.client.user?.displayAvatarURL() })
          .setTimestamp();

        if ('editReply' in target) {
          await target.editReply({ embeds: [embed] });
        } else {
          await target.edit({ embeds: [embed] });
        }
      } catch (err: any) {
        if (err?.code === 10008 || err?.code === 10015 || err?.code === 10062) {
          clearInterval(interval);
          this.activeTickers.delete(key);
        }
      } finally {
        isUpdating = false;
      }
    }, 1500);

    this.activeTickers.set(key, {
      interval,
      stop: () => {
        clearInterval(interval);
        this.activeTickers.delete(key);
      },
    });
  }

  // Handle Slash Command
  private async handleSlashCommand(interaction: ChatInputCommandInteraction) {
    const { commandName, user, guildId, channelId, channel } = interaction;
    const contextId = guildId || channelId || user.id;

    await this.clearPreviousBotMessages(user.id, channel);

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch {
      return;
    }

    this.lastUserInteractions.set(user.id, interaction);

    try {
      switch (commandName) {
        case 'configure': {
          const rawSession = interaction.options.getString('session', true);
          const session = rawSession
            .replace(/^ATERNOS_SESSION=/i, '')
            .replace(/;.*$/, '')
            .replace(/^["']|["']$/g, '')
            .trim();
          const serverInput = interaction.options.getString('server')?.trim();

          // Discover available servers from this session
          const discovered: DiscoveredServer[] = await aternosService.discoverServersFromSession(session);

          // If user provided a server input, try to match or fallback to canonical address
          let matchedServer: DiscoveredServer | undefined = undefined;
          let wasInputWrong = false;

          const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '').replace(/\.aternos\.me$/i, '');

          if (serverInput) {
            const inputNorm = norm(serverInput);
            matchedServer = discovered.find(
              s =>
                s.id.toLowerCase() === serverInput.toLowerCase() ||
                s.serverCookie.toLowerCase() === serverInput.toLowerCase() ||
                s.serverAddress.toLowerCase() === serverInput.toLowerCase() ||
                s.name.toLowerCase() === serverInput.toLowerCase() ||
                norm(s.serverAddress) === inputNorm ||
                norm(s.name) === inputNorm ||
                norm(s.id) === inputNorm
            );

            if (!matchedServer) {
              const canonical = serverStorage.getCanonicalServerAddress(serverInput);
              const existingProfile = serverStorage.getProfile(serverInput);
              matchedServer = {
                id: existingProfile?.serverCookie || existingProfile?.id || canonical.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
                name: canonical,
                serverAddress: canonical,
                serverCookie: existingProfile?.serverCookie || 'C97GPgj1GU2y7wWc',
              };
            }
          } else if (discovered.length === 1) {
            matchedServer = discovered[0];
          }

          // Case 1: Match found with provided server ID / address
          if (matchedServer) {
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
            .setColor(wasInputWrong ? 0xf59e0b : 0x3b82f6)
            .setTitle(wasInputWrong ? '⚠️ Server ID Not Found — Choose From Available Servers' : '📋 Choose Your Aternos Server')
            .setDescription(
              wasInputWrong
                ? `The server ID \`${serverInput}\` was not recognized on your account.\n\nFound **${discovered.length} server(s)** linked to your session. Select the server you want to control from the dropdown below:`
                : `Found **${discovered.length} server(s)** linked to your session account. Select the server you want to control from the dropdown below:`
            )
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
          let state = aternosService.getState(ctx.serverAddress);
          if (ctx.sessionCookie && (state.status === 'offline' || Date.now() - state.lastUpdated > 8000)) {
            try {
              state = await aternosService.syncSessionState(ctx.serverAddress);
            } catch {}
          }
          const live = await queryMinecraftServer(ctx.serverAddress, state.dynip, state.playersOnline || 0);

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
          let state = aternosService.getState(ctx.serverAddress);
          if (ctx.sessionCookie && (state.status === 'online' || Date.now() - state.lastUpdated > 8000)) {
            try {
              state = await aternosService.syncSessionState(ctx.serverAddress);
            } catch {}
          }
          const live = await queryMinecraftServer(ctx.serverAddress, state.dynip, state.playersOnline || 0);

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
          // Always ensure fresh state from Aternos first so we never report offline when server is running
          let state = aternosService.getState(ctx.serverAddress);
          if (ctx.sessionCookie || state.status === 'offline' || Date.now() - state.lastUpdated > 8000) {
            try {
              state = await aternosService.syncSessionState(ctx.serverAddress);
            } catch {}
          }
          const live = await queryMinecraftServer(ctx.serverAddress, state.dynip, state.playersOnline || 0);

          const embed = this.buildStatusEmbed(ctx.serverAddress, state, live);
          await interaction.editReply({ embeds: [embed] });

          const isOnline = state.status === 'online' || live.online;
          const playerCount = Math.max(live.players?.online || 0, state.playersOnline || 0);
          if (isOnline && playerCount === 0) {
            this.startStatusLiveTicker(user.id, ctx.serverAddress, interaction);
          }
          break;
        }

        case 'players': {
          const ctx = this.resolveServerContext(contextId, user.id);
          // Always sync state from Aternos immediately so we don't think it's offline
          let state = aternosService.getState(ctx.serverAddress);
          if (ctx.sessionCookie || state.status === 'offline' || Date.now() - state.lastUpdated > 8000) {
            try {
              state = await aternosService.syncSessionState(ctx.serverAddress);
            } catch {}
          }
          const live = await queryMinecraftServer(ctx.serverAddress, state.dynip, state.playersOnline || 0);

          if (!live.online && state.status !== 'online' && state.status !== 'starting') {
            const embed = new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle('🔴 Server is Offline')
              .setDescription(`Cannot fetch active players because **${ctx.serverAddress}** is currently offline.\nUse \`/start\` to bring the server online.`);
            await interaction.editReply({ embeds: [embed] });
            return;
          }

          const count = Math.max(live.players?.online || 0, state.playersOnline || 0);
          const max = live.players?.max || state.maxPlayers || 20;
          const playerList = live.players?.list || [];

          if (count === 0 && playerList.length === 0) {
            const embed = new EmbedBuilder()
              .setColor(0x71717a)
              .setTitle(`👥 No Players Online (0/${max})`)
              .setDescription(`There are currently 0 players connected to **${ctx.serverAddress}**.\nThe world is quiet and waiting for players to join.`);

            if (state.status === 'online' || live.online) {
              const secs = state.countdownSeconds ?? 360;
              const mins = Math.floor(secs / 60);
              const s = secs % 60;
              const formatted = state.countdownFormatted || `${mins}:${s < 10 ? '0' : ''}${s}`;
              const targetEpoch = Math.floor(Date.now() / 1000) + secs;

              embed.addFields({
                name: '⏱️ Keepalive Timer',
                value: `\`${formatted}\` remaining • Auto-shutdown <t:${targetEpoch}:R>\n*(Updated live like in Aternos dashboard)*`,
                inline: false,
              });
            }

            embed.setFooter({ text: 'Aternos Command Center', iconURL: this.client.user?.displayAvatarURL() });
            embed.setTimestamp();

            await interaction.editReply({ embeds: [embed] });

            if (state.status === 'online' || live.online) {
              this.startPlayersLiveTicker(user.id, ctx.serverAddress, interaction, max);
            }
            return;
          }

          const embed = new EmbedBuilder()
            .setColor(0x10b981)
            .setTitle(`👥 Online Players (${count}/${max})`)
            .setDescription(`Active players currently connected to **${ctx.serverAddress}**:`)
            .setTimestamp();

          if (playerList.length > 0) {
            const playerLines = await Promise.all(
              playerList.map(async (p, idx) => {
                const headEmoji = await this.getPlayerHeadEmoji(p.name);
                return `**${idx + 1}.** ${headEmoji} **${p.name}**`;
              })
            );

            // Double newline spacing between players as requested
            embed.addFields({ name: 'Connected Players', value: playerLines.join('\n\n'), inline: false });
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
      console.error(`[Discord /${commandName} Error]`, err);
      try {
        await interaction.editReply({ content: `❌ Command Error: ${err.message || 'Operation failed'}` });
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
    } catch (err: any) {
      console.error('[Select Menu Error]', err);
    }
  }

  // Handle Text Fallbacks (!status, !players, !start, !stop, etc.)
  private async handleMessageFallback(message: Message) {
    const content = message.content.trim();
    if (!content.startsWith('!') && !content.startsWith('/')) return;

    const parts = content.slice(1).split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);
    const contextId = message.guildId || message.channelId || message.author.id;
    const userId = message.author.id;

    await this.clearPreviousBotMessages(userId, message.channel);

    try {
      await message.delete();
    } catch {}

    const ctx = this.resolveServerContext(contextId, userId);

    if (cmd === 'status') {
      let state = aternosService.getState(ctx.serverAddress);
      if (ctx.sessionCookie || state.status === 'offline' || Date.now() - state.lastUpdated > 8000) {
        try {
          state = await aternosService.syncSessionState(ctx.serverAddress);
        } catch {}
      }
      const live = await queryMinecraftServer(ctx.serverAddress, state.dynip, state.playersOnline || 0);

      const embed = this.buildStatusEmbed(ctx.serverAddress, state, live);
      const reply = await message.reply({ embeds: [embed] });
      this.lastUserMessages.set(userId, reply);

      const isOnline = state.status === 'online' || live?.online;
      const count = Math.max(live?.players?.online || 0, state.playersOnline || 0);
      if (isOnline && count === 0) {
        this.startStatusLiveTicker(userId, ctx.serverAddress, reply);
      }
    } else if (cmd === 'players') {
      let state = aternosService.getState(ctx.serverAddress);
      if (ctx.sessionCookie || state.status === 'offline' || Date.now() - state.lastUpdated > 8000) {
        try {
          state = await aternosService.syncSessionState(ctx.serverAddress);
        } catch {}
      }
      const live = await queryMinecraftServer(ctx.serverAddress, state.dynip, state.playersOnline || 0);

      if (!live?.online && state.status !== 'online' && state.status !== 'starting') {
        const reply = await message.reply({ content: `🔴 **Server is offline.** Cannot retrieve players for \`${ctx.serverAddress}\`.` });
        this.lastUserMessages.set(userId, reply);
        return;
      }

      const count = Math.max(live?.players?.online || 0, state.playersOnline || 0);
      const max = live?.players?.max || state.maxPlayers || 20;
      const playerList = live?.players?.list || [];

      if (count === 0 && playerList.length === 0) {
        const embed = new EmbedBuilder()
          .setColor(0x71717a)
          .setTitle(`👥 No Players Online (0/${max})`)
          .setDescription(`There are currently 0 players connected to **${ctx.serverAddress}**.\nThe world is quiet and waiting for players to join.`);

        if (state.status === 'online' || live?.online) {
          const secs = state.countdownSeconds ?? 360;
          const mins = Math.floor(secs / 60);
          const s = secs % 60;
          const formatted = state.countdownFormatted || `${mins}:${s < 10 ? '0' : ''}${s}`;
          const targetEpoch = Math.floor(Date.now() / 1000) + secs;

          embed.addFields({
            name: '⏱️ Keepalive Timer',
            value: `\`${formatted}\` remaining • Auto-shutdown <t:${targetEpoch}:R>\n*(Updated live like in Aternos dashboard)*`,
            inline: false,
          });
        }

        embed.setFooter({ text: 'Aternos Command Center', iconURL: this.client.user?.displayAvatarURL() });
        embed.setTimestamp();

        const reply = await message.reply({ embeds: [embed] });
        this.lastUserMessages.set(userId, reply);

        if (state.status === 'online' || live?.online) {
          this.startPlayersLiveTicker(userId, ctx.serverAddress, reply, max);
        }
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0x10b981)
        .setTitle(`👥 Online Players (${count}/${max})`)
        .setDescription(`Active players currently on **${ctx.serverAddress}**:`)
        .setTimestamp();

      if (playerList.length > 0) {
        const playerLines = await Promise.all(
          playerList.map(async (p, idx) => {
            const headEmoji = await this.getPlayerHeadEmoji(p.name);
            return `**${idx + 1}.** ${headEmoji} **${p.name}**`;
          })
        );
        // Double newline spacing between players as requested
        embed.addFields({ name: 'Connected Players', value: playerLines.join('\n\n'), inline: false });
      } else {
        embed.setDescription(`**${count}** player${count > 1 ? 's' : ''} connected.`);
      }

      embed.setFooter({ text: 'Aternos Command Center', iconURL: this.client.user?.displayAvatarURL() });

      const reply = await message.reply({ embeds: [embed] });
      this.lastUserMessages.set(userId, reply);
    } else if (cmd === 'start') {
      let state = aternosService.getState(ctx.serverAddress);
      if (ctx.sessionCookie && (state.status === 'offline' || Date.now() - state.lastUpdated > 8000)) {
        try {
          state = await aternosService.syncSessionState(ctx.serverAddress);
        } catch {}
      }
      const live = await queryMinecraftServer(ctx.serverAddress, state.dynip, state.playersOnline || 0);

      if (state.status === 'online' || live.online) {
        const reply = await message.reply({
          content: `⚠️ **Server is already Online!** \`${ctx.serverAddress}\` is running and ready for players.`,
        });
        this.lastUserMessages.set(userId, reply);
        return;
      }

      const res = await aternosService.startServer(ctx.serverAddress, {
        sessionCookie: ctx.sessionCookie,
        serverCookie: ctx.serverCookie,
        serverAddress: ctx.serverAddress,
      });

      const reply = await message.reply({
        content: res.success
          ? `🚀 **Server Boot Initiated!** Startup sequence dispatched for \`${ctx.serverAddress}\` (~1-2 mins).`
          : `❌ **Failed to start server:** ${res.message}`,
      });
      this.lastUserMessages.set(userId, reply);
    } else if (cmd === 'stop') {
      const state = aternosService.getState(ctx.serverAddress);
      const live = await queryMinecraftServer(ctx.serverAddress, state.dynip, state.playersOnline || 0);

      if (state.status === 'offline' && !live.online) {
        const reply = await message.reply({
          content: `⚠️ **Server is already Offline!** \`${ctx.serverAddress}\` is already turned off.`,
        });
        this.lastUserMessages.set(userId, reply);
        return;
      }

      const res = await aternosService.stopServer(ctx.serverAddress, {
        sessionCookie: ctx.sessionCookie,
        serverCookie: ctx.serverCookie,
        serverAddress: ctx.serverAddress,
      });

      const reply = await message.reply({
        content: res.success
          ? `🛑 **Server Shutdown Initiated!** Stop signal dispatched for \`${ctx.serverAddress}\`.`
          : `❌ **Failed to stop server:** ${res.message}`,
      });
      this.lastUserMessages.set(userId, reply);
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
