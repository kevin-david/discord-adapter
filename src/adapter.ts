import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  type Guild,
  type ForumChannel,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type {
  OutgoingMessage,
  PermissionRequest,
  NotificationMessage,
  AgentCommand,
  PlanEntry,
  Attachment,
  OpenACPCore,
  Session,
  DisplayVerbosity,
  AdapterCapabilities,
  IRenderer,
  MessagingAdapterConfig,
  FileServiceInterface,
  CommandResponse,
  SettingsAPI,
} from "@openacp/plugin-sdk";
import { log, MessagingAdapter, SendQueue } from "@openacp/plugin-sdk";
import type { CommandRegistry } from "@openacp/plugin-sdk";
import { DiscordRenderer } from "./renderer.js";
import type { DiscordChannelConfig } from "./types.js";
import { DiscordDraftManager } from "./draft-manager.js";
import { ActivityTracker, type ToolCallMeta, type OutputMode, type TunnelServiceInterface } from "./activity.js";
import { SkillCommandManager } from "./skill-command-manager.js";
import { PermissionHandler } from "./permissions.js";
import {
  ensureForums,
  createSessionThread as forumsCreateThread,
  renameSessionThread as forumsRenameThread,
  deleteSessionThread as forumsDeleteThread,
  updateSessionThreadStarter as forumsUpdateStarter,
  ensureUnarchived,
  buildDeepLink,
} from "./forums.js";
import {
  registerSlashCommands,
  handleSlashCommand,
  setupButtonCallbacks,
  buildMenuKeyboard,
} from "./commands/index.js";
import { buildSessionControlKeyboard } from "./commands/admin.js";
import { spawnAssistant, buildWelcomeMessage } from "./assistant.js";
import {
  buildFallbackText,
  downloadDiscordAttachment,
  isAttachmentTooLarge,
} from "./media.js";

export class DiscordAdapter extends MessagingAdapter {
  readonly name = 'discord';
  readonly renderer: IRenderer = new DiscordRenderer();
  readonly capabilities: AdapterCapabilities = {
    streaming: true, richFormatting: true, threads: true,
    reactions: true, fileUpload: true, voice: false,
  };

  readonly core: OpenACPCore;
  private client: Client;
  private discordConfig: DiscordChannelConfig;
  private settingsAPI: SettingsAPI | undefined;
  private sendQueue: SendQueue;
  private draftManager: DiscordDraftManager;
  private _outputModeResolver = new OutputModeResolver();
  private skillManager!: SkillCommandManager;
  private permissionHandler!: PermissionHandler;
  private sessionTrackers: Map<string, ActivityTracker> = new Map();

  private guild!: Guild;
  private forumChannel!: ForumChannel | TextChannel;
  private notificationChannel!: TextChannel;
  private assistantSession: Session | null = null;
  private assistantInitializing = false;
  private pendingAssistantSystemPrompt: string | null = null;
  private fileService: FileServiceInterface;

  // Per-session thread context for concurrency safety in sendMessage handlers
  private _sessionContexts = new Map<string, { thread: ThreadChannel; isAssistant: boolean }>();
  private _configChangedHandler?: (data: { sessionId: string }) => void;
  private _threadReadyHandler?: (data: { sessionId: string; channelId: string; threadId: string }) => void;

  constructor(core: OpenACPCore, config: DiscordChannelConfig, settingsAPI: SettingsAPI | undefined) {
    super(
      { configManager: core.configManager },
      { ...config as Record<string, unknown>, maxMessageLength: 2000, enabled: config.enabled ?? true } as MessagingAdapterConfig,
    );
    this.core = core;
    this.discordConfig = config;
    this.settingsAPI = settingsAPI;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.sendQueue = new SendQueue({ minInterval: 1000 });
    this.draftManager = new DiscordDraftManager(this.sendQueue);
    this.fileService = core.fileService;

    // Wire discord.js rate limit events to send queue
    this.client.rest.on("rateLimited", (info) => {
      log.warn(
        { route: info.route, timeToReset: info.timeToReset },
        "[DiscordAdapter] Rate limited",
      );
      this.sendQueue.onRateLimited();
    });
  }

  // ─── Plugin settings helpers ──────────────────────────────────────────────

  /**
   * Persists a plugin setting to disk and updates the in-memory config so
   * subsequent reads within the same session see the new value immediately.
   */
  async savePluginSetting(key: string, value: unknown): Promise<void> {
    if (this.settingsAPI) {
      if (value === undefined) {
        await this.settingsAPI.delete(key)
      } else {
        await this.settingsAPI.set(key, value)
      }
    }
    // Keep in-memory config in sync so callers don't need a restart to see the change.
    (this.discordConfig as Record<string, unknown>)[key] = value
  }

  /** Returns the adapter-level output mode from plugin settings, or undefined if not set. */
  get adapterOutputMode(): OutputMode | undefined {
    const v = this.discordConfig.outputMode
    if (v === 'low' || v === 'medium' || v === 'high') return v as OutputMode
    return undefined
  }

  // ─── start ────────────────────────────────────────────────────────────────

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.once("ready", async () => {
        try {
          log.info(
            { guildId: this.discordConfig.guildId },
            "[DiscordAdapter] Client ready, initializing...",
          );

          // Fetch guild
          const guild =
            this.client.guilds.cache.get(this.discordConfig.guildId) ??
            (await this.client.guilds
              .fetch(this.discordConfig.guildId)
              .catch(() => null));
          if (!guild) {
            throw new Error(`Guild not found: ${this.discordConfig.guildId}`);
          }
          this.guild = guild;

          // Ensure forum + notification channels exist
          const { forumChannel, notificationChannel } = await ensureForums(
            guild,
            {
              forumChannelId: this.discordConfig.forumChannelId,
              notificationChannelId: this.discordConfig.notificationChannelId,
            },
            (key, value) => this.savePluginSetting(key, value),
          );
          this.forumChannel = forumChannel;
          this.notificationChannel = notificationChannel;

          // Init managers that need guild/guildId
          this.skillManager = new SkillCommandManager(
            this.sendQueue,
            this.core.sessionManager,
          );
          this.permissionHandler = new PermissionHandler(
            guild.id,
            (sessionId) => this.core.sessionManager.getSession(sessionId),
            (notification) => this.sendNotification(notification),
          );

          // Register slash commands
          await registerSlashCommands(guild);

          // Wire interaction + message handlers
          this.setupInteractionHandler();
          this.setupMessageHandler();

          // Welcome message with menu buttons so users can quickly start sessions
          const welcomeMsg = buildWelcomeMessage(this.core);
          const menuComponents = buildMenuKeyboard();
          try {
            await this.notificationChannel.send({ content: welcomeMsg, components: menuComponents });
          } catch (err) {
            log.warn(
              { err },
              "[DiscordAdapter] Failed to send welcome message",
            );
          }

          // Spawn assistant session
          await this.setupAssistant();

          // Update control message when session config changes via commands
          this._configChangedHandler = ({ sessionId }) => {
            this.updateControlMessage(sessionId).catch(() => {});
          };
          this.core.eventBus.on('session:configChanged', this._configChangedHandler);

          // Send welcome + control messages for sessions created via API/CLI (not via /new command)
          this._threadReadyHandler = ({ sessionId, channelId, threadId }) => {
            if (channelId !== 'discord') return;
            const session = this.core.sessionManager.getSession(sessionId);
            if (!session) return;
            // Assistant manages its own welcome message
            if (this.assistantSession && sessionId === this.assistantSession.id) return;

            this.guild.channels.fetch(threadId)
              .then((channel) => {
                if (!channel || !channel.isThread()) return;
                const thread = channel as ThreadChannel;
                return thread.send({ content: '⏳ Setting up session, please wait...' })
                  .then(() =>
                    thread.send({
                      content:
                        `✅ **Session started**\n` +
                        `**Agent:** ${session.agentName}\n` +
                        `**Workspace:** \`${session.workingDirectory}\`\n\n` +
                        `This is your coding session — chat here to work with the agent.`,
                      components: [buildSessionControlKeyboard(sessionId, false, false)],
                    }),
                  )
                  .then(async (controlMsg) => {
                    await this.persistControlMsgId(sessionId, controlMsg.id);
                    await forumsUpdateStarter(
                      thread,
                      `📂 **${session.agentName}** — \`${session.workingDirectory}\``,
                    );
                  });
              })
              .catch((err) => {
                log.warn({ err, sessionId, threadId }, '[DiscordAdapter] Failed to send initial messages for API-created session');
              });
          };
          this.core.eventBus.on('session:threadReady', this._threadReadyHandler);

          log.info("[DiscordAdapter] Initialization complete");
          resolve();
        } catch (err) {
          log.error({ err }, "[DiscordAdapter] Initialization failed");
          reject(err);
        }
      });

      this.client.login(this.discordConfig.botToken).catch(reject);
    });
  }

  // ─── stop ─────────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (this.assistantSession) {
      try {
        await this.assistantSession.destroy();
      } catch (err) {
        log.warn(
          { err },
          "[DiscordAdapter] Failed to destroy assistant session",
        );
      }
      this.assistantSession = null;
    }
    if (this._configChangedHandler) {
      this.core.eventBus.off('session:configChanged', this._configChangedHandler);
      this._configChangedHandler = undefined;
    }
    if (this._threadReadyHandler) {
      this.core.eventBus.off('session:threadReady', this._threadReadyHandler);
      this._threadReadyHandler = undefined;
    }
    this.client.destroy();
    log.info("[DiscordAdapter] Stopped");
  }

  // ─── Interaction handler ──────────────────────────────────────────────────

  private getCommandRegistry(): CommandRegistry | undefined {
    return this.core.lifecycleManager?.serviceRegistry?.get<CommandRegistry>("command-registry");
  }

  private setupInteractionHandler(): void {
    this.client.on("interactionCreate", async (interaction) => {
      try {
        // --- Generic CommandRegistry dispatch (slash commands) ---
        if (interaction.isChatInputCommand()) {
          const registry = this.getCommandRegistry();
          if (registry) {
            const commandName = interaction.commandName;
            const def = registry.get(commandName);
            if (def) {
              const rawParts: string[] = [];
              for (const opt of interaction.options.data) {
                rawParts.push(String(opt.value ?? ""));
              }

              const channelId = interaction.channelId;
              const sessionId =
                this.core.sessionManager.getSessionByThread("discord", channelId)?.id ?? null;

              const response = await registry.execute(
                `/${commandName} ${rawParts.join(" ")}`.trim(),
                {
                  raw: "",
                  sessionId,
                  channelId: "discord",
                  userId: interaction.user.id,
                  options: Object.fromEntries(
                    interaction.options.data.map((o) => [o.name, String(o.value ?? "")]),
                  ),
                  reply: async (content: string) => {
                    if (typeof content === "string") {
                      if (interaction.replied || interaction.deferred) {
                        await interaction.editReply({ content });
                      } else {
                        await interaction.reply({ content });
                      }
                    }
                  },
                },
              );

              if (response.type !== "silent") {
                await this.renderCommandResponse(response, interaction);
              } else if (!interaction.replied && !interaction.deferred) {
                await interaction.deferReply();
              }
              return; // handled by registry
            }
          }

          // Fall through to existing slash command router
          await handleSlashCommand(interaction, this);
          return;
        }

        // --- Button interactions ---
        if (interaction.isButton()) {
          // Command registry buttons (c/ prefix) — check before permission/legacy
          if (interaction.customId.startsWith("c/")) {
            const registry = this.getCommandRegistry();
            if (registry) {
              const command = interaction.customId.slice(2);
              const channelId = interaction.channelId;
              const sessionId =
                this.core.sessionManager.getSessionByThread("discord", channelId)?.id ?? null;

              const response = await registry.execute(command, {
                raw: "",
                sessionId,
                channelId: "discord",
                userId: interaction.user.id,
                reply: async (content: string) => {
                  if (typeof content === "string") {
                    if (interaction.replied || interaction.deferred) {
                      await interaction.editReply({ content });
                    } else {
                      await interaction.reply({ content, ephemeral: true });
                    }
                  }
                },
              });

              if (response.type !== "silent") {
                await this.renderCommandResponse(response, interaction);
              }
              return;
            }
          }

          // Permission buttons take priority over legacy
          const handled =
            await this.permissionHandler.handleButtonInteraction(interaction);
          if (!handled) {
            await setupButtonCallbacks(interaction, this);
          }
        }
      } catch (err) {
        log.error({ err }, "[DiscordAdapter] interactionCreate handler error");
      }
    });
  }

  // ─── CommandRegistry response rendering ──────────────────────────────────

  private async renderCommandResponse(
    response: CommandResponse,
    interaction: import("discord.js").ChatInputCommandInteraction | import("discord.js").ButtonInteraction | import("discord.js").StringSelectMenuInteraction,
  ): Promise<void> {
    const reply = async (opts: Record<string, unknown>) => {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(opts);
      } else {
        await interaction.reply(opts);
      }
    };

    switch (response.type) {
      case "text":
        await reply({ content: response.text });
        break;
      case "adaptive": {
        const variant = response.variants?.['discord'] as
          | { content?: string; embeds?: unknown[] }
          | undefined;
        await reply({
          content: variant?.content ?? response.fallback,
          ...(variant?.embeds && { embeds: variant.embeds }),
        });
        break;
      }
      case "error":
        await reply({ content: `\u26a0\ufe0f ${response.message}`, ephemeral: true });
        break;
      case "menu": {
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } =
          await import("discord.js");
        const embed = new EmbedBuilder().setTitle(response.title);
        const rows: InstanceType<typeof ActionRowBuilder>[] = [];
        // Max 5 buttons per row, max 5 rows
        for (let i = 0; i < response.options.length && rows.length < 5; i += 5) {
          const row = new ActionRowBuilder();
          const slice = response.options.slice(i, i + 5);
          for (const opt of slice) {
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`c/${opt.command}`)
                .setLabel(opt.label.slice(0, 80))
                .setStyle(ButtonStyle.Secondary),
            );
          }
          rows.push(row);
        }
        await reply({ embeds: [embed], components: rows });
        break;
      }
      case "list": {
        const { EmbedBuilder } = await import("discord.js");
        const desc = response.items
          .map((i) => `\u2022 **${i.label}**${i.detail ? ` \u2014 ${i.detail}` : ""}`)
          .join("\n");
        const embed = new EmbedBuilder()
          .setTitle(response.title)
          .setDescription(desc);
        await reply({ embeds: [embed] });
        break;
      }
      case "confirm": {
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } =
          await import("discord.js");
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`c/${response.onYes}`)
            .setLabel("Yes")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`c/${response.onNo || "noop"}`)
            .setLabel("No")
            .setStyle(ButtonStyle.Secondary),
        );
        await reply({ content: response.question, components: [row] });
        break;
      }
      case "silent":
        break;
    }
  }

  // ─── Message handler ──────────────────────────────────────────────────────

  private setupMessageHandler(): void {
    this.client.on("messageCreate", async (message) => {
      try {
        // Ignore bots and self
        if (message.author.bot) return;

        // Ignore DMs
        if (!message.guild) return;

        // Ignore messages from the wrong guild
        if (message.guild.id !== this.guild.id) return;

        // Only process messages in threads
        if (!message.channel.isThread()) return;

        const threadId = message.channel.id;
        const userId = message.author.id;
        let text = message.content;

        log.debug(
          {
            threadId,
            userId,
            text: text.slice(0, 50),
            attachmentCount: message.attachments.size,
          },
          "[DiscordAdapter] messageCreate received",
        );

        // Ignore messages with no text and no attachments
        if (!text && message.attachments.size === 0) return;

        // Resolve sessionId for file storage (fallback to "unknown" for new sessions)
        const sessionId =
          this.core.sessionManager.getSessionByThread("discord", threadId)
            ?.id ?? "unknown";

        // Process attachments
        if (message.attachments.size > 0) {
          log.info(
            {
              sessionId,
              attachments: message.attachments.map((a) => ({
                name: a.name,
                size: a.size,
                contentType: a.contentType,
                url: a.url?.slice(0, 80),
              })),
            },
            "[discord-media] Processing incoming attachments",
          );
        }
        const attachments = await this.processIncomingAttachments(
          message,
          sessionId,
        );

        // Generate fallback text if message has attachments but no text
        if (!text && attachments.length > 0) {
          text = buildFallbackText(attachments);
        }

        // If all attachment downloads failed and no text, notify user
        if (!text && attachments.length === 0 && message.attachments.size > 0) {
          try {
            await message.reply("Failed to process attachment(s)");
          } catch {
            /* best effort */
          }
          return;
        }

        // Route assistant thread messages to assistant
        if (
          this.discordConfig.assistantThreadId &&
          threadId === this.discordConfig.assistantThreadId
        ) {
          if (this.assistantSession && text) {
            let promptText = text;
            if (this.pendingAssistantSystemPrompt) {
              promptText = `${this.pendingAssistantSystemPrompt}\n\n---\n\nUser message:\n${text}`;
              this.pendingAssistantSystemPrompt = null;
            }
            await this.assistantSession.enqueuePrompt(
              promptText,
              attachments.length > 0 ? attachments : undefined,
            );
          }
          return;
        }

        // Reset tracker state and finalize any in-flight draft for existing sessions.
        // Some agents (e.g. gemini) don't emit usage/tool_call events between turns,
        // so a new user message is the only reliable signal that the prior turn ended.
        // Without finalizing here, streaming text from this turn appends to the prior
        // message draft and the previous "💭 Still thinking..." / typing indicators
        // never clear.
        if (sessionId !== "unknown") {
          const tracker = this.sessionTrackers.get(sessionId);
          if (tracker) {
            await tracker.onNewPrompt();
          }
          if (message.channel.isThread()) {
            const isAssistant = this.assistantSession != null && sessionId === this.assistantSession.id;
            await this.draftManager.finalize(sessionId, message.channel as ThreadChannel, isAssistant);
          }
        }

        // Route to core for session dispatch
        await this.core.handleMessage({
          channelId: "discord",
          threadId,
          userId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
      } catch (err) {
        log.error({ err }, "[DiscordAdapter] messageCreate handler error");
      }
    });
  }

  // ─── Assistant ────────────────────────────────────────────────────────────

  private async setupAssistant(): Promise<void> {
    let threadId = this.discordConfig.assistantThreadId;

    // Verify existing thread is still accessible
    if (threadId) {
      try {
        const existing =
          this.guild.channels.cache.get(threadId) ??
          (await this.guild.channels.fetch(threadId));
        if (existing && existing.isThread()) {
          await ensureUnarchived(
            existing as import("discord.js").ThreadChannel,
          );
          log.info(
            { threadId },
            "[DiscordAdapter] Reusing existing assistant thread",
          );
        } else {
          log.warn(
            { threadId },
            "[DiscordAdapter] Assistant thread not found, recreating...",
          );
          threadId = null;
        }
      } catch {
        log.warn(
          { threadId },
          "[DiscordAdapter] Assistant thread inaccessible, recreating...",
        );
        threadId = null;
      }
    }

    if (!threadId) {
      // Create a new thread for the assistant
      const thread = await forumsCreateThread(this.forumChannel, "Assistant");
      threadId = thread.id;
      await this.savePluginSetting('assistantThreadId', thread.id)
      log.info({ threadId }, "[DiscordAdapter] Created assistant thread");
    }

    this.assistantInitializing = true;
    try {
      const { session, pendingSystemPrompt } = await spawnAssistant(this.core, threadId);
      this.assistantSession = session;
      this.pendingAssistantSystemPrompt = pendingSystemPrompt;
      this.assistantInitializing = false;
    } catch (err) {
      this.assistantInitializing = false;
      log.error({ err }, "[DiscordAdapter] Failed to spawn assistant");
    }
  }

  async respawnAssistant(): Promise<void> {
    if (this.assistantSession) {
      try {
        await this.assistantSession.destroy();
      } catch {
        /* ignore */
      }
      this.assistantSession = null;
    }
    await this.setupAssistant();
  }

  // ─── Incoming media ──────────────────────────────────────────────────

  private async processIncomingAttachments(
    message: import("discord.js").Message,
    sessionId: string,
  ): Promise<Attachment[]> {
    if (message.attachments.size === 0) return [];

    const isVoiceMessage = message.flags.has(MessageFlags.IsVoiceMessage);

    const results = await Promise.allSettled(
      message.attachments.map(async (discordAtt) => {
        const buffer = await downloadDiscordAttachment(
          discordAtt.url,
          discordAtt.name ?? "attachment",
        );
        if (!buffer) return null;

        let data = buffer;
        let fileName = discordAtt.name ?? "attachment";
        let mimeType = discordAtt.contentType ?? "application/octet-stream";

        // Convert voice messages from OGG Opus to WAV
        if (isVoiceMessage && mimeType.includes("ogg")) {
          try {
            data = await this.fileService.convertOggToWav(buffer);
            fileName = "voice.wav";
            mimeType = "audio/wav";
          } catch (err) {
            log.warn(
              { err },
              "[discord-media] OGG→WAV conversion failed, saving original",
            );
          }
        }

        return this.fileService.saveFile(sessionId, fileName, data, mimeType);
      }),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    if (rejected.length > 0) {
      log.warn(
        { rejected: rejected.map((r) => (r as PromiseRejectedResult).reason) },
        "[discord-media] Some attachments failed",
      );
    }

    const saved = results
      .filter(
        (r): r is PromiseFulfilledResult<Attachment | null> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value)
      .filter((att): att is Attachment => att !== null);

    log.info(
      { count: saved.length, files: saved.map((a) => a.fileName) },
      "[discord-media] Attachments processed",
    );
    return saved;
  }

  // ─── Helper: resolve thread ───────────────────────────────────────────────

  private async getThread(sessionId: string): Promise<ThreadChannel | null> {
    const session = this.core.sessionManager.getSession(sessionId);
    const threadId = session?.threadId;
    if (!threadId) {
      log.warn({ sessionId }, "[DiscordAdapter] No threadId for session");
      return null;
    }
    try {
      const channel =
        this.guild.channels.cache.get(threadId) ??
        (await this.guild.channels.fetch(threadId));
      if (channel && channel.isThread()) return channel as ThreadChannel;
      log.warn(
        { sessionId, threadId },
        "[DiscordAdapter] Channel is not a thread",
      );
      return null;
    } catch (err) {
      log.warn(
        { err, sessionId, threadId },
        "[DiscordAdapter] Failed to fetch thread",
      );
      return null;
    }
  }

  // ─── Helper: get or create activity tracker ──────────────────────────────

  private resolveMode(sessionId: string): OutputMode {
    return this._outputModeResolver.resolve(
      this.discordConfig,
      this.core.configManager as any,
      sessionId,
      this.core.sessionManager as any,
    );
  }

  private getOrCreateTracker(
    sessionId: string,
    thread: TextChannel | ThreadChannel,
    outputMode: OutputMode = "medium",
  ): ActivityTracker {
    let tracker = this.sessionTrackers.get(sessionId);
    if (!tracker) {
      const tunnelService = this.core.lifecycleManager?.serviceRegistry?.get("tunnel") as TunnelServiceInterface | undefined;
      const session = this.core.sessionManager.getSession(sessionId);
      const sessionContext = session
        ? { id: sessionId, workingDirectory: session.workingDirectory }
        : undefined;
      tracker = new ActivityTracker(
        thread,
        this.sendQueue,
        outputMode,
        sessionId,
        tunnelService,
        sessionContext,
      );
      this.sessionTrackers.set(sessionId, tracker);
    } else {
      tracker.setOutputMode(outputMode);
    }
    return tracker;
  }

  /** Called from button router to switch mode and re-render the current tool card. */
  updateSessionOutputMode(sessionId: string, mode: OutputMode): void {
    const tracker = this.sessionTrackers.get(sessionId);
    if (!tracker) return;
    tracker.setOutputMode(mode);
    tracker.rerender();
  }

  /**
   * Edit the control message to reflect current session state (bypass, voice mode).
   * No-op if the control message ID is unknown (session created before this fix).
   */
  async updateControlMessage(sessionId: string): Promise<void> {
    const controlMsgId = this.getControlMsgId(sessionId);
    if (!controlMsgId) return;

    const thread = await this.getThread(sessionId);
    if (!thread) return;

    const session = this.core.sessionManager.getSession(sessionId);
    if (!session) return;

    const keyboard = buildSessionControlKeyboard(
      sessionId,
      session.clientOverrides?.bypassPermissions ?? false,
      session.voiceMode === 'on',
    );

    try {
      const msg = await thread.messages.fetch(controlMsgId);
      await msg.edit({ components: [keyboard] });
    } catch {
      // Message deleted or inaccessible — ignore
    }
  }

  private getSessionContext(sessionId: string): { thread: ThreadChannel; isAssistant: boolean } {
    const ctx = this._sessionContexts.get(sessionId);
    if (!ctx) {
      throw new Error(`No thread context stored for session ${sessionId}`);
    }
    return ctx;
  }

  /**
   * Finalize the in-flight text draft for a session. Public so the `turn:end`
   * middleware can trigger it on every prompt completion — without this, agents
   * that don't emit `usage`/`session_end` at turn end leave the draft stuck at
   * its mid-stream truncation (~1900 chars) instead of splitting into the full
   * multi-message response.
   */
  async finalizeSessionDraft(sessionId: string): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId);
    const threadId = session?.threadId;
    if (!threadId) return;
    try {
      const channel = this.guild.channels.cache.get(threadId)
        ?? await this.guild.channels.fetch(threadId).catch(() => null);
      if (!channel?.isThread()) return;
      const thread = channel as ThreadChannel;
      const isAssistant = this.assistantSession != null && sessionId === this.assistantSession.id;
      await this.draftManager.finalize(sessionId, thread, isAssistant);
    } catch (err) {
      log.warn({ err, sessionId }, "[DiscordAdapter] finalizeSessionDraft failed");
    }
  }

  // ─── sendMessage ──────────────────────────────────────────────────────────

  async sendMessage(
    sessionId: string,
    content: OutgoingMessage,
  ): Promise<void> {
    // Suppress output while assistant is initializing its system prompt
    if (
      this.assistantInitializing &&
      this.assistantSession &&
      sessionId === this.assistantSession.id
    ) {
      return;
    }

    const thread = await this.getThread(sessionId);
    if (!thread) return;

    await ensureUnarchived(thread);

    // Store thread context keyed by sessionId for concurrency safety
    this._sessionContexts.set(sessionId, {
      thread,
      isAssistant: this.assistantSession != null && sessionId === this.assistantSession.id,
    });

    try {
      // Resolve verbosity from discord plugin settings (and per-session override)
      // rather than the base class's channel-config lookup, which doesn't see our
      // plugin-settings-backed outputMode and would always fall back to "medium".
      const verbosity = this.resolveMode(sessionId);
      if (!this.shouldDisplay(content, verbosity)) return;
      await this.dispatchMessage(sessionId, content, verbosity);
    } finally {
      this._sessionContexts.delete(sessionId);
    }
  }

  // ─── Handler overrides ─────────────────────────────────────────────────────

  protected async handleThought(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const { thread } = this.getSessionContext(sessionId);
    const mode = this.resolveMode(sessionId);
    const tracker = this.getOrCreateTracker(sessionId, thread, mode);
    await tracker.onThought(content.text || "");
  }

  protected async handleText(sessionId: string, content: OutgoingMessage): Promise<void> {
    const { thread } = this.getSessionContext(sessionId);
    if (!this.draftManager.hasDraft(sessionId)) {
      const mode = this.resolveMode(sessionId);
      const tracker = this.getOrCreateTracker(sessionId, thread, mode);
      await tracker.onTextStart();
    }
    const draft = this.draftManager.getOrCreate(sessionId, thread);
    draft.append(content.text);
    this.draftManager.appendText(sessionId, content.text);

    // Gemini-acp emits chain-of-thought as inline text and signals the end of
    // the thought block with `[Thought: true]`. Everything BEFORE the marker
    // is the thought; everything AFTER is the response. At medium/low we hide
    // the thought by retroactively trimming the draft to only the post-marker
    // content. At high we keep everything visible.
    const verbosity = this.resolveMode(sessionId);
    if (verbosity !== "high") {
      const buffer = draft.getBuffer();
      const marker = "[Thought: true]";
      const idx = buffer.lastIndexOf(marker);
      if (idx >= 0) {
        const postMarker = buffer.slice(idx + marker.length).replace(/^\s+/, "");
        if (postMarker !== buffer) {
          draft.replaceBuffer(postMarker);
        }
      }
    }
  }

  protected async handleToolCall(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const { thread, isAssistant } = this.getSessionContext(sessionId);
    const meta = (content.metadata ?? {}) as Partial<ToolCallMeta>;
    const mode = this.resolveMode(sessionId);
    const tracker = this.getOrCreateTracker(sessionId, thread, mode);
    await this.draftManager.finalize(sessionId, thread, isAssistant);
    await tracker.onToolCall(
      {
        id: meta.id ?? "",
        name: meta.name ?? content.text ?? "Tool",
        kind: meta.kind,
        status: meta.status,
        content: meta.content,
        rawInput: meta.rawInput,
        viewerLinks: meta.viewerLinks,
        viewerFilePath: meta.viewerFilePath,
        displaySummary: meta.displaySummary as string | undefined,
        displayTitle: meta.displayTitle as string | undefined,
        displayKind: meta.displayKind as string | undefined,
      },
      String(meta.kind ?? ""),
      meta.rawInput,
    );
  }

  protected async handleToolUpdate(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const { thread } = this.getSessionContext(sessionId);
    const meta = (content.metadata ?? {}) as Partial<ToolCallMeta & { diffStats?: { added: number; removed: number } }>;
    const mode = this.resolveMode(sessionId);
    const tracker = this.getOrCreateTracker(sessionId, thread, mode);
    await tracker.onToolUpdate(
      meta.id ?? "",
      meta.status ?? "completed",
      meta.viewerLinks as { file?: string; diff?: string } | undefined,
      typeof meta.content === "string" ? meta.content : null,
      meta.rawInput ?? undefined,
      meta.diffStats as { added: number; removed: number } | undefined,
    );
  }

  protected async handlePlan(sessionId: string, content: OutgoingMessage, _verbosity: DisplayVerbosity): Promise<void> {
    const { thread } = this.getSessionContext(sessionId);
    const meta = (content.metadata ?? {}) as { entries?: PlanEntry[] };
    const entries = meta.entries ?? [];
    const mode = this.resolveMode(sessionId);
    const tracker = this.getOrCreateTracker(sessionId, thread, mode);
    await tracker.onPlan(entries);
  }

  protected async handleUsage(sessionId: string, content: OutgoingMessage, verbosity: DisplayVerbosity): Promise<void> {
    const { thread, isAssistant } = this.getSessionContext(sessionId);
    await this.draftManager.finalize(sessionId, thread, isAssistant);

    // Per-mode display rules:
    //   low    — usage events are filtered upstream by HIDDEN_ON_LOW; this
    //             handler isn't called at low (so the in-flight text draft does
    //             not get finalized via this path; that's a pre-existing bug
    //             that low users can hit. Out of scope here.)
    //   medium — handler runs, draft is finalized, but no embed or Task-completed
    //   high   — full receipts: usage embed + Task-completed cross-channel ping
    // Usage embeds and the Task-completed ping are noisy at the default tier;
    // they're now an opt-in via 'high' for users who explicitly want metrics.
    if (verbosity !== "high") return;

    const meta = content.metadata as { tokensUsed?: number; contextSize?: number; cost?: number; duration?: number } | undefined;
    const mode = this.resolveMode(sessionId);

    try {
      const { renderUsageEmbed } = await import("./formatting.js");
      const embed = renderUsageEmbed(meta ?? {}, mode);
      await this.sendQueue.enqueue(
        () => thread.send({ embeds: [embed] }),
        { type: "other" },
      );
    } catch (err) {
      log.warn({ err, sessionId }, "Failed to send usage embed");
    }

    if (this.notificationChannel && sessionId !== this.assistantSession?.id) {
      const sess = this.core.sessionManager.getSession(sessionId);
      const name = sess?.name || "Session";
      try {
        await this.notificationChannel.send(`\u2705 **${name}** \u2014 Task completed.`);
      } catch {
        /* best effort */
      }
    }
  }

  protected async handleSessionEnd(sessionId: string, _content: OutgoingMessage): Promise<void> {
    const { thread, isAssistant } = this.getSessionContext(sessionId);
    await this.draftManager.finalize(sessionId, thread, isAssistant);
    this.draftManager.cleanup(sessionId);
    await this.skillManager.cleanup(sessionId);
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      await tracker.cleanup();
      this.sessionTrackers.delete(sessionId);
    } else {
      try {
        await this.sendQueue.enqueue(
          () => thread.send({ content: "\u2705 **Done**" }),
          { type: "other" },
        );
      } catch {
        /* best effort */
      }
    }
  }

  protected async handleConfigUpdate(sessionId: string, _content: OutgoingMessage): Promise<void> {
    await this.updateControlMessage(sessionId);
  }

  protected async handleError(sessionId: string, content: OutgoingMessage): Promise<void> {
    const { thread, isAssistant } = this.getSessionContext(sessionId);
    await this.draftManager.finalize(sessionId, thread, isAssistant);
    const tracker = this.sessionTrackers.get(sessionId);
    if (tracker) {
      tracker.destroy();
      this.sessionTrackers.delete(sessionId);
    }
    try {
      await this.sendQueue.enqueue(
        () => thread.send({ content: `\u274c **Error:** ${content.text}` }),
        { type: "other" },
      );
    } catch {
      /* best effort */
    }
  }

  protected async handleAttachment(sessionId: string, content: OutgoingMessage): Promise<void> {
    if (!content.attachment) return;
    const { attachment } = content;
    const { thread, isAssistant } = this.getSessionContext(sessionId);
    await this.draftManager.finalize(
      sessionId,
      thread,
      isAssistant,
    );

    // Discord free tier limit: 25MB
    if (isAttachmentTooLarge(attachment.size)) {
      log.warn(
        {
          sessionId,
          fileName: attachment.fileName,
          size: attachment.size,
        },
        "[discord-media] File too large (>25MB)",
      );
      try {
        await this.sendQueue.enqueue(
          () =>
            thread.send({
              content: `⚠️ File too large to send (${Math.round(attachment.size / 1024 / 1024)}MB): ${attachment.fileName}`,
            }),
          { type: "other" },
        );
      } catch {
        /* best effort */
      }
      return;
    }

    try {
      await this.sendQueue.enqueue(
        () =>
          thread.send({
            files: [
              { attachment: attachment.filePath, name: attachment.fileName },
            ],
          }),
        { type: "other" },
      );

      // Strip [TTS]...[/TTS] block from the text message after audio is sent.
      // This fires after sendQueue completes, so the draft message already exists.
      // stripPattern is best-effort and handles missing/finalized drafts gracefully.
      if (attachment.type === "audio") {
        const draft = this.draftManager.getDraft(sessionId);
        if (draft) {
          draft.stripPattern(/\[TTS\][\s\S]*?\[\/TTS\]/g).catch(() => {});
        }
      }
    } catch (err) {
      log.error(
        { err, sessionId, fileName: attachment.fileName },
        "[discord-media] Failed to send attachment",
      );
    }
  }

  protected async handleSystem(sessionId: string, content: OutgoingMessage): Promise<void> {
    const { thread } = this.getSessionContext(sessionId);
    try {
      await this.sendQueue.enqueue(
        () => thread.send({ content: content.text }),
        { type: "other" },
      );
    } catch {
      /* best effort */
    }
  }

  // ─── sendPermissionRequest ────────────────────────────────────────────────

  async sendPermissionRequest(
    sessionId: string,
    request: PermissionRequest,
  ): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId);
    if (!session) {
      log.warn(
        { sessionId },
        "[DiscordAdapter] sendPermissionRequest: session not found",
      );
      return;
    }

    const thread = await this.getThread(sessionId);
    if (!thread) return;

    await this.permissionHandler.sendPermissionRequest(
      session,
      request,
      thread,
    );
  }

  // ─── sendNotification ─────────────────────────────────────────────────────

  async sendNotification(notification: NotificationMessage): Promise<void> {
    if (!this.notificationChannel) return;

    const typeIcon: Record<string, string> = {
      completed: "✅",
      error: "❌",
      permission: "🔐",
      input_required: "💬",
    };

    const icon = typeIcon[notification.type] ?? "ℹ️";
    const name = notification.sessionName
      ? ` **${notification.sessionName}**`
      : "";
    let text = `${icon}${name}: ${notification.summary}`;
    if (notification.deepLink) {
      text += `\n${notification.deepLink}`;
    }

    try {
      await this.sendQueue.enqueue(
        () => this.notificationChannel.send({ content: text }),
        { type: "other" },
      );
    } catch (err) {
      log.warn({ err }, "[DiscordAdapter] Failed to send notification");
    }
  }

  // ─── createSessionThread ─────────────────────────────────────────────────

  async createSessionThread(sessionId: string, name: string): Promise<string> {
    const thread = await forumsCreateThread(this.forumChannel, name);

    // Persist threadId on session record
    const session = this.core.sessionManager.getSession(sessionId);
    if (session) {
      session.threadId = thread.id;
    }

    const record = this.core.sessionManager.getSessionRecord(sessionId);
    if (record) {
      await this.core.sessionManager.patchRecord(sessionId, {
        platform: { ...record.platform, threadId: thread.id },
      });
    }

    return thread.id;
  }

  // ─── renameSessionThread ──────────────────────────────────────────────────

  async renameSessionThread(sessionId: string, newName: string): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId);
    const threadId = session?.threadId;
    if (!threadId) return;
    await forumsRenameThread(this.guild, threadId, newName);
  }

  // ─── deleteSessionThread ──────────────────────────────────────────────────

  async deleteSessionThread(sessionId: string): Promise<void> {
    const session = this.core.sessionManager.getSession(sessionId);
    const threadId = session?.threadId;
    if (!threadId) return;
    await forumsDeleteThread(this.guild, threadId);
  }

  // ─── sendSkillCommands ────────────────────────────────────────────────────

  async sendSkillCommands(
    sessionId: string,
    commands: AgentCommand[],
  ): Promise<void> {
    const thread = await this.getThread(sessionId);
    if (!thread) return;
    await this.skillManager.send(sessionId, thread, commands);
  }

  // ─── cleanupSkillCommands ─────────────────────────────────────────────────

  async cleanupSkillCommands(sessionId: string): Promise<void> {
    await this.skillManager.cleanup(sessionId);
  }

  // ─── Public helpers (for slash commands) ─────────────────────────────────

  getForumChannel(): ForumChannel | TextChannel {
    return this.forumChannel;
  }

  getGuild(): Guild {
    return this.guild;
  }

  getGuildId(): string {
    return this.guild.id;
  }

  getAssistantSessionId(): string | null {
    return this.assistantSession?.id ?? null;
  }

  getAssistantThreadId(): string | null {
    return this.discordConfig.assistantThreadId;
  }

  /**
   * Persist the control message ID to the session record so it survives restart.
   * Called after sending the welcome/control message in new-session.ts.
   */
  async persistControlMsgId(sessionId: string, messageId: string): Promise<void> {
    const record = this.core.sessionManager.getSessionRecord(sessionId);
    if (!record) return;
    await this.core.sessionManager.patchRecord(sessionId, {
      platform: { ...(record.platform ?? {}), controlMsgId: messageId },
    }).catch((err) => {
      log.warn({ err, sessionId }, "[DiscordAdapter] Failed to persist controlMsgId");
    });
  }

  /**
   * Retrieve stored control message ID for a session (survives restart via session record).
   */
  getControlMsgId(sessionId: string): string | undefined {
    const record = this.core.sessionManager.getSessionRecord(sessionId);
    const platform = record?.platform as { controlMsgId?: string } | undefined;
    return platform?.controlMsgId;
  }
}

// ─── OutputModeResolver ────────────────────────────────────────────────────────
// Resolves output mode with 3-level cascade:
// Session override -> Adapter override -> Global default -> "medium"

class OutputModeResolver {
  resolve(
    // Adapter-level setting comes from plugin settings (discordConfig), not legacy core config.
    discordConfig: { outputMode?: unknown },
    configManager: { get(): Record<string, unknown> },
    sessionId?: string,
    sessionManager?: { getSession(id: string): { record?: { outputMode?: string } } | undefined },
  ): OutputMode {
    // Level 3: Session override (highest priority)
    if (sessionId && sessionManager) {
      const session = sessionManager.getSession(sessionId);
      const mode = session?.record?.outputMode;
      if (mode === "low" || mode === "medium" || mode === "high") return mode;
    }
    // Level 2: Adapter override (from plugin settings)
    const adapterMode = discordConfig.outputMode;
    if (adapterMode === "low" || adapterMode === "medium" || adapterMode === "high") return adapterMode as OutputMode;
    // Level 1: Global default (from core config)
    const globalMode = configManager.get().outputMode;
    if (globalMode === "low" || globalMode === "medium" || globalMode === "high") return globalMode as OutputMode;
    return "medium";
  }
}
