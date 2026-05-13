import type { TextChannel, ThreadChannel, Message } from "discord.js";
import { log } from "@openacp/plugin-sdk";
import {
  renderToolCard,
  type OutputMode,
  type ToolDisplaySpec,
  type ToolCardSnapshot,
  type PlanEntry,
} from "./formatting.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type { OutputMode, ToolDisplaySpec, ToolCardSnapshot, PlanEntry };

export interface ToolCallMeta {
  id: string;
  name: string;
  kind?: string;
  status?: string;
  content?: unknown;
  rawInput?: unknown;
  viewerLinks?: ViewerLinks;
  viewerFilePath?: string;
  displaySummary?: string;
  displayTitle?: string;
  displayKind?: string;
}

export interface ViewerLinks {
  file?: string;
  diff?: string;
}

export interface TunnelServiceInterface {
  getPublicUrl(): string | null;
  outputUrl(id: string): string;
  getStore(): {
    storeOutput(sessionId: string, label: string, content: string): string | null;
  };
}

/** Minimal SendQueue interface — the real one comes from @openacp/plugin-sdk */
export interface SendQueue {
  enqueue<T>(fn: () => Promise<T>, opts?: { type?: string }): Promise<T | undefined>;
}

// ─── ToolEntry ───────────────────────────────────────────────────────────────

export interface ToolEntry {
  id: string;
  name: string;
  kind: string;
  rawInput: unknown;
  content: string | null;
  status: string;
  viewerLinks?: ViewerLinks;
  diffStats?: { added: number; removed: number };
  displaySummary?: string;
  displayTitle?: string;
  displayKind?: string;
  isNoise: boolean;
}

// ─── ThinkingIndicator ────────────────────────────────────────────────────────

// Refresh the "thinking" message every 15s to show elapsed time.
// Auto-stop after 3 minutes to avoid leaving stale indicators.
const THINKING_REFRESH_MS = 15_000;
const THINKING_MAX_MS = 3 * 60 * 1000;

/**
 * Manages the transient "💭 Thinking..." message shown while the agent is reasoning.
 *
 * Sends a message on `show()`, periodically edits it with elapsed time, and
 * dismisses it (leaving the message in chat) when text output begins. Leaving
 * the message avoids an extra API delete call; the indicator is just no longer updated.
 */
export class ThinkingIndicator {
  private msg?: Message;
  private sending = false;
  private dismissed = false;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private showTime = 0;

  constructor(
    private channel: TextChannel | ThreadChannel,
    private sendQueue: SendQueue,
  ) {}

  async show(): Promise<void> {
    if (this.sending || this.dismissed || this.msg) return;
    this.sending = true;
    this.showTime = Date.now();
    try {
      const result = await this.sendQueue.enqueue(() =>
        this.channel.send({ content: "💭 *Thinking...*" }),
      );
      if (result) {
        if (!this.dismissed) {
          this.msg = result;
          this.startRefreshTimer();
        }
      }
    } catch (err) {
      log.warn({ err }, "[ThinkingIndicator] show() failed");
    } finally {
      this.sending = false;
    }
  }

  /**
   * Edit the indicator to append a viewer link for thinking content, then dismiss.
   * Used in high output mode when a tunnel is available.
   */
  async finalizeWithViewerLink(url: string): Promise<void> {
    this.stopRefreshTimer();
    if (this.msg && !this.dismissed) {
      const msgRef = this.msg;
      await this.sendQueue
        .enqueue(() => msgRef.edit({ content: `💭 *Thinking...* — [View thinking](${url})` }))
        .catch(() => {});
    }
    this.dismissed = true;
    this.msg = undefined;
  }

  /** Dismiss indicator: stops refresh timer. Message stays in chat to reduce API calls. */
  async dismiss(): Promise<void> {
    if (this.dismissed) return;
    this.dismissed = true;
    this.stopRefreshTimer();
    this.msg = undefined;
  }

  /** Reset for a new prompt cycle. */
  reset(): void {
    this.stopRefreshTimer();
    this.dismissed = false;
    this.msg = undefined;
    this.sending = false;
  }

  private startRefreshTimer(): void {
    this.stopRefreshTimer();
    this.refreshTimer = setInterval(() => {
      if (this.dismissed || !this.msg || Date.now() - this.showTime >= THINKING_MAX_MS) {
        this.stopRefreshTimer();
        return;
      }
      const elapsed = Math.round((Date.now() - this.showTime) / 1000);
      const msgRef = this.msg;
      this.sendQueue
        .enqueue(() => {
          // Re-check after waiting in queue — dismiss may have been called
          if (this.dismissed || !msgRef) return Promise.resolve(undefined);
          return msgRef.edit({ content: `💭 *Still thinking... (${elapsed}s)*` });
        })
        .catch(() => {});
    }, THINKING_REFRESH_MS);
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }
}

// ─── ToolStateMap ────────────────────────────────────────────────────────────

interface PendingUpdate {
  status: string;
  rawInput?: unknown;
  content?: string | null;
  viewerLinks?: ViewerLinks;
  diffStats?: { added: number; removed: number };
}

export class ToolStateMap {
  private entries: Map<string, ToolEntry> = new Map();
  private pendingUpdates: Map<string, PendingUpdate> = new Map();

  upsert(meta: ToolCallMeta, kind: string, rawInput: unknown): ToolEntry {
    const isNoise = evaluateNoise(meta.name, kind, rawInput);

    const entry: ToolEntry = {
      id: meta.id,
      name: meta.name,
      kind,
      rawInput,
      content: null,
      status: meta.status ?? "running",
      viewerLinks: meta.viewerLinks,
      displaySummary: meta.displaySummary,
      displayTitle: meta.displayTitle,
      displayKind: meta.displayKind,
      isNoise,
    };

    this.entries.set(meta.id, entry);

    const pending = this.pendingUpdates.get(meta.id);
    if (pending) {
      this.pendingUpdates.delete(meta.id);
      applyUpdate(entry, pending);
    }

    return entry;
  }

  merge(
    id: string,
    status: string,
    rawInput?: unknown,
    content?: string | null,
    viewerLinks?: ViewerLinks,
    diffStats?: { added: number; removed: number },
  ): ToolEntry | undefined {
    const entry = this.entries.get(id);

    if (!entry) {
      this.pendingUpdates.set(id, { status, rawInput, content, viewerLinks, diffStats });
      return undefined;
    }

    applyUpdate(entry, { status, rawInput, content, viewerLinks, diffStats });
    return entry;
  }

  get(id: string): ToolEntry | undefined {
    return this.entries.get(id);
  }

  forEach(cb: (entry: ToolEntry) => void): void {
    this.entries.forEach(cb);
  }

  clear(): void {
    this.entries.clear();
    this.pendingUpdates.clear();
  }
}

function applyUpdate(entry: ToolEntry, update: PendingUpdate): void {
  entry.status = update.status;
  if (update.rawInput !== undefined) entry.rawInput = update.rawInput;
  if (update.content !== undefined) entry.content = update.content ?? null;
  if (update.viewerLinks !== undefined) entry.viewerLinks = update.viewerLinks;
  if (update.diffStats !== undefined) entry.diffStats = update.diffStats;
}

// Gemini-acp internal bookkeeping tool titles — hidden at low/medium, shown
// with 👁️ at high.
//
// Gemini emits tool titles via two paths:
//   1. Live (in-progress) events use the invocation's getDescription(),
//      producing dynamic strings like:
//        - 'Update topic to: "<title>"'
//        - 'Update tactical intent: "<intent>"'
//   2. Replayed (completed/historical) events use the tool's static
//      displayName, producing exact strings like:
//        - "Update Topic Context"
//        - "Invoke Subagent"
//
// The exact set covers the replay path. The prefixes anchor on the literal
// `: "` that the dynamic format always emits, so they can't accidentally
// match a future tool named (e.g.) "Update topic permissions".
//
// Live subagent invocations emit "Invoke <agent-name>" with a user-
// configurable suffix; we can't safely match those without enumerating
// every subagent name, so they fall through and stay visible.
const GEMINI_NOISE_EXACT = new Set(["update topic context", "invoke subagent"]);
const GEMINI_NOISE_PREFIXES = ['update topic to: "', 'update tactical intent: "'];

/** Simple noise evaluation — noise tools are hidden in low/medium modes */
function evaluateNoise(name: string, _kind: string, _rawInput: unknown): boolean {
  const lower = name.toLowerCase();
  // Claude: TodoRead/TodoWrite, ToolResult with no content
  if (lower.includes("todo")) return true;
  if (lower === "toolresult") return true;
  if (GEMINI_NOISE_EXACT.has(lower)) return true;
  if (GEMINI_NOISE_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return false;
}

// ─── ThoughtBuffer ───────────────────────────────────────────────────────────

export class ThoughtBuffer {
  private chunks: string[] = [];
  private sealed = false;

  append(chunk: string): void {
    if (this.sealed) return;
    this.chunks.push(chunk);
  }

  seal(): string {
    this.sealed = true;
    return this.chunks.join("");
  }

  getText(): string {
    return this.chunks.join("");
  }

  isSealed(): boolean {
    return this.sealed;
  }

  reset(): void {
    this.chunks = [];
    this.sealed = false;
  }
}

// ─── DisplaySpecBuilder ──────────────────────────────────────────────────────

const KIND_ICONS: Record<string, string> = {
  read: "📖",
  edit: "✏️",
  write: "✏️",
  delete: "🗑️",
  execute: "▶️",
  command: "▶️",
  bash: "▶️",
  terminal: "▶️",
  search: "🔍",
  web: "🌐",
  fetch: "🌐",
  agent: "🧠",
  think: "🧠",
  install: "📦",
  move: "📦",
  other: "🛠️",
};

const EXECUTE_KINDS = new Set(["execute", "bash", "command", "terminal"]);

const INLINE_MAX_LINES = 15;
const INLINE_MAX_CHARS = 800;

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function buildTitle(entry: ToolEntry, kind: string): string {
  const input = asRecord(entry.rawInput);

  // We prefer rawInput-derived titles over agent-supplied displayTitle whenever
  // we have the raw data. Some agents (gemini) emit prettified displayTitle
  // strings that capitalize the first character — "Life/finance/" instead of
  // "life/finance/", "Find /path" instead of "find /path", etc. The rawInput
  // field is the source of truth.
  //
  // Order: kind-specific raw fields → displayTitle/displaySummary → capitalize fallback.

  if (EXECUTE_KINDS.has(kind)) {
    const command = typeof input.command === "string" ? input.command : null;
    if (command) return command.length > 60 ? command.slice(0, 57) + "..." : command;
    // No command param: agents like gemini name argless tools with TitleCase
    // ("Pwd", "Ls") and use the tool name as the bash command. Lowercase it —
    // but ONLY for short single-word identifiers, so we don't mangle agents
    // that happen to put a full command into entry.name.
    if (entry.name && /^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(entry.name)) {
      return entry.name.toLowerCase();
    }
    const description = typeof input.description === "string" ? input.description : null;
    if (description) return description;
  }

  if (kind === "read") {
    const filePath = typeof input.file_path === "string" ? input.file_path : null;
    if (filePath) {
      const startLine = typeof input.start_line === "number" ? input.start_line : null;
      const endLine = typeof input.end_line === "number" ? input.end_line : null;
      if (startLine !== null && endLine !== null) return `${filePath} (lines ${startLine}–${endLine})`;
      if (startLine !== null) return `${filePath} (from line ${startLine})`;
      const offset = typeof input.offset === "number" ? input.offset : null;
      const limit = typeof input.limit === "number" ? input.limit : null;
      if (offset !== null && limit !== null) return `${filePath} (lines ${offset}–${offset + limit - 1})`;
      if (offset !== null) return `${filePath} (from line ${offset})`;
      return filePath;
    }
  }

  if (kind === "edit" || kind === "write" || kind === "delete") {
    const filePath =
      typeof input.file_path === "string"
        ? input.file_path
        : typeof input.path === "string"
          ? input.path
          : null;
    if (filePath) return filePath;
  }

  if (kind === "agent") {
    const skill = typeof input.skill === "string" ? input.skill : null;
    const description = typeof input.description === "string" ? input.description : null;
    const subtype = typeof input.subagent_type === "string" ? input.subagent_type : null;
    if (skill) return skill;
    if (description) return description.length > 60 ? description.slice(0, 57) + "..." : description;
    if (subtype) return subtype;
  }

  if (kind === "search") {
    const pattern =
      typeof input.pattern === "string"
        ? input.pattern
        : typeof input.query === "string"
          ? input.query
          : null;
    if (pattern) {
      let title = `${capitalize(entry.name)} "${pattern}"`;
      const glob = typeof input.glob === "string" ? input.glob : null;
      const type = typeof input.type === "string" ? input.type : null;
      if (glob) title += ` (glob: ${glob})`;
      else if (type) title += ` (type: ${type})`;
      return title;
    }
  }

  if (entry.name.toLowerCase() === "skill" && typeof input.skill === "string" && input.skill) {
    return input.skill;
  }

  // Fall back to agent-supplied display strings, then to the tool name itself.
  if (entry.displayTitle) return entry.displayTitle;
  if (entry.displaySummary) return entry.displaySummary;

  // Gemini-acp puts the actual content (file paths, search patterns,
  // natural-language descriptions) in `entry.name` with no rawInput and no
  // displayTitle. Preserve case rather than capitalizing the first letter —
  // capitalize() corrupted real paths like "daily-notes/..." into
  // "Daily-notes/...". The EXECUTE_KINDS branch above already lowercases
  // short identifiers like "Pwd" → "pwd" for that specific case.
  return entry.name;
}

function buildOutputSummary(content: string): string {
  const lines = content.split("\n").length;
  return `${lines} line${lines === 1 ? "" : "s"} of output`;
}

function isTitleFromCommand(title: string, command: string): boolean {
  return title === command || (command.length > 60 && title === command.slice(0, 57) + "...");
}

export class DisplaySpecBuilder {
  constructor(private tunnelService?: TunnelServiceInterface) {}

  buildToolSpec(
    entry: ToolEntry,
    mode: OutputMode,
    sessionContext?: { id: string; workingDirectory: string },
  ): ToolDisplaySpec {
    const effectiveKind = entry.displayKind ?? entry.kind;
    const icon = KIND_ICONS[effectiveKind] ?? KIND_ICONS["other"] ?? "🛠️";
    const title = buildTitle(entry, effectiveKind);
    const isHidden = entry.isNoise && mode !== "high";

    const includeMeta = mode !== "low";
    const input = asRecord(entry.rawInput);

    const rawDescription = typeof input.description === "string" ? input.description : null;
    const descLower = rawDescription?.toLowerCase();
    const description =
      includeMeta && rawDescription && rawDescription !== title
        && descLower !== effectiveKind && descLower !== entry.name.toLowerCase()
        ? rawDescription : null;

    const rawCommand =
      EXECUTE_KINDS.has(effectiveKind) && typeof input.command === "string"
        ? input.command
        : null;
    const command =
      includeMeta && rawCommand && !isTitleFromCommand(title, rawCommand)
        ? rawCommand
        : null;

    const inputContent: string | null = null;
    const content = entry.content;

    let outputSummary: string | null = null;
    let outputContent: string | null = null;
    let outputViewerLink: string | undefined = undefined;
    let outputFallbackContent: string | undefined = undefined;

    if (content && content.trim().length > 0 && includeMeta) {
      outputSummary = buildOutputSummary(content);

      const isLong =
        content.split("\n").length > INLINE_MAX_LINES || content.length > INLINE_MAX_CHARS;

      if (isLong) {
        const publicUrl = this.tunnelService?.getPublicUrl();
        const hasPublicTunnel = !!publicUrl && !publicUrl.startsWith("http://localhost") && !publicUrl.startsWith("http://127.0.0.1");
        if (this.tunnelService && sessionContext && hasPublicTunnel) {
          const label =
            typeof input.command === "string" ? input.command : entry.name;
          const id = this.tunnelService.getStore().storeOutput(sessionContext.id, label, content);
          if (id !== null) {
            outputViewerLink = this.tunnelService.outputUrl(id);
          }
        } else if (mode === "high") {
          outputFallbackContent = content;
        }
      } else if (mode === "high") {
        outputContent = content;
      }
    }

    const diffStats = includeMeta ? (entry.diffStats ?? null) : null;

    return {
      id: entry.id,
      kind: effectiveKind,
      icon,
      title,
      description,
      command,
      inputContent,
      outputSummary,
      outputContent,
      diffStats,
      viewerLinks: entry.viewerLinks,
      outputViewerLink,
      outputFallbackContent,
      status: entry.status,
      isNoise: entry.isNoise,
      isHidden,
    };
  }
}

// ─── ToolCardState ───────────────────────────────────────────────────────────

const DEBOUNCE_MS = 500;
const DONE_STATUSES = new Set(["completed", "done", "failed", "error"]);

interface ToolCardStateConfig {
  onFlush: (snapshot: ToolCardSnapshot) => void;
}

export class ToolCardState {
  private specs: ToolDisplaySpec[] = [];
  private planEntries?: PlanEntry[];
  private finalized = false;
  private isFirstFlush = true;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private onFlush: (snapshot: ToolCardSnapshot) => void;

  constructor(config: ToolCardStateConfig) {
    this.onFlush = config.onFlush;
  }

  updateFromSpec(spec: ToolDisplaySpec): void {
    const existingIdx = this.specs.findIndex((s) => s.id === spec.id);
    if (existingIdx >= 0) {
      this.specs[existingIdx] = spec;
    } else {
      this.specs.push(spec);
    }

    if (this.finalized) {
      this.onFlush(this.snapshot());
      return;
    }

    if (this.isFirstFlush) {
      this.isFirstFlush = false;
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  updatePlan(entries: PlanEntry[]): void {
    if (this.finalized) return;
    this.planEntries = entries;

    if (this.specs.length === 0 && this.isFirstFlush) {
      this.isFirstFlush = false;
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.clearDebounce();
    this.flush();
  }

  destroy(): void {
    this.finalized = true;
    this.clearDebounce();
  }

  hasContent(): boolean {
    return this.specs.length > 0 || this.planEntries !== undefined;
  }

  private snapshot(): ToolCardSnapshot {
    const visible = this.specs.filter((s) => !s.isHidden);
    const completedVisible = visible.filter((s) => DONE_STATUSES.has(s.status)).length;
    const allComplete = visible.length > 0 && completedVisible === visible.length;
    return {
      specs: this.specs,
      planEntries: this.planEntries,
      totalVisible: visible.length,
      completedVisible,
      allComplete,
    };
  }

  private flush(): void {
    this.clearDebounce();
    this.onFlush(this.snapshot());
  }

  private scheduleFlush(): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.flush();
    }, DEBOUNCE_MS);
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }
}

// ─── ActivityTracker ──────────────────────────────────────────────────────────

const TYPING_REFRESH_MS = 8_000;

export class ActivityTracker {
  private _outputMode: OutputMode;
  private sessionId: string;
  private channel: TextChannel | ThreadChannel;
  private sendQueue: SendQueue;
  private tunnelService?: TunnelServiceInterface;
  private sessionContext?: { id: string; workingDirectory: string };

  // Internal primitives
  private toolStateMap: ToolStateMap;
  private previousToolStateMap?: ToolStateMap;
  private specBuilder: DisplaySpecBuilder;
  private toolCard?: ToolCardState;
  private previousToolCard?: ToolCardState;
  private thoughtBuffer: ThoughtBuffer;
  private toolCardMsg?: Message;
  private previousToolCardMsg?: Message;
  // Per-cycle state preserved for re-renders
  private _currentPlanEntries?: PlanEntry[];
  private _prevThoughtViewerLink?: string;

  // Thinking indicator (visible "💭 Thinking..." message)
  private thinkingIndicator: ThinkingIndicator;

  // Typing indicator state
  private typingDismissed = false;
  private typingRefreshTimer?: ReturnType<typeof setInterval>;

  // Flush promise chain per card
  private flushPromise: Promise<void> = Promise.resolve();
  private previousFlushPromise: Promise<void> = Promise.resolve();
  // Mutable ref so the onFlush closure can self-detect after sealToolCard swaps it
  private _currentCardRef?: { isPrevious: boolean };

  constructor(
    channel: TextChannel | ThreadChannel,
    sendQueue: SendQueue,
    outputMode: OutputMode = "medium",
    sessionId: string = "",
    tunnelService?: TunnelServiceInterface,
    sessionContext?: { id: string; workingDirectory: string },
  ) {
    this.channel = channel;
    this.sendQueue = sendQueue;
    this._outputMode = outputMode;
    this.sessionId = sessionId;
    this.tunnelService = tunnelService;
    this.sessionContext = sessionContext;
    this.specBuilder = new DisplaySpecBuilder(tunnelService);
    this.toolStateMap = new ToolStateMap();
    this.thoughtBuffer = new ThoughtBuffer();
    this.thinkingIndicator = new ThinkingIndicator(channel, sendQueue);
  }

  setOutputMode(mode: OutputMode): void {
    this._outputMode = mode;
  }

  /** Re-render the current tool card with the current outputMode.
   *  Called when the user switches output mode mid-prompt via action row buttons. */
  rerender(): void {
    if (!this.toolCard) return;
    this.toolStateMap.forEach((entry) => {
      const spec = this.specBuilder.buildToolSpec(entry, this._outputMode, this.sessionContext);
      this.toolCard!.updateFromSpec(spec);
    });
    if (this._currentPlanEntries) {
      this.toolCard.updatePlan(this._currentPlanEntries);
    }
  }

  async onNewPrompt(): Promise<void> {
    this.thoughtBuffer.reset();
    this.thinkingIndicator.reset();
    this.stopTyping();

    // Finalize current card
    if (this.toolCard) {
      this.toolCard.finalize();
      await this.flushPromise;
    }

    // Mark card as previous BEFORE swapping so any late flushes use the right chain
    if (this._currentCardRef) {
      this._currentCardRef.isPrevious = true;
      this._currentCardRef = undefined;
    }

    // Discard old previous card's context before overwriting
    this._prevThoughtViewerLink = undefined;

    // Swap current → previous
    this.previousToolCard = this.toolCard;
    this.previousToolCardMsg = this.toolCardMsg;
    this.previousToolStateMap = this.toolStateMap;
    this.previousFlushPromise = this.flushPromise;

    // Fresh state for new prompt
    this.toolStateMap = new ToolStateMap();
    this.toolCard = undefined;
    this.toolCardMsg = undefined;
    this.flushPromise = Promise.resolve();
    this._currentPlanEntries = undefined;
  }

  async onThought(text: string): Promise<void> {
    if (!this.thoughtBuffer.isSealed()) {
      this.thoughtBuffer.append(text);
    }
    this.typingDismissed = false;
    // Show visible "💭 Thinking..." message on first thought chunk
    await this.thinkingIndicator.show();
    await this.startTyping();
  }

  async onTextStart(): Promise<void> {
    const thoughtText = this.thoughtBuffer.seal();
    this.stopTyping();

    // Seal current tool card so new tools go to a new card
    await this.sealToolCard();

    // In high mode with tunnel: store thought, surface viewer link on indicator + previous card
    if (this._outputMode === "high" && this.tunnelService && this.sessionContext) {
      if (thoughtText.trim().length > 0) {
        const id = this.tunnelService.getStore().storeOutput(
          this.sessionContext.id,
          "thinking",
          thoughtText,
        );
        if (id !== null) {
          this._prevThoughtViewerLink = this.tunnelService.outputUrl(id);
          // Update thinking indicator message to include viewer link before dismissing
          await this.thinkingIndicator.finalizeWithViewerLink(this._prevThoughtViewerLink);
          // Re-render previous card to include the 💭 viewer link
          if (this.previousToolStateMap && this.previousToolCard) {
            this.previousToolStateMap.forEach((entry) => {
              const spec = this.specBuilder.buildToolSpec(entry, this._outputMode, this.sessionContext);
              this.previousToolCard!.updateFromSpec(spec);
            });
          }
          return;
        }
      }
    }

    // Dismiss without viewer link
    await this.thinkingIndicator.dismiss();
  }

  async onToolCall(
    meta: ToolCallMeta,
    kind: string,
    rawInput: unknown,
  ): Promise<void> {
    this.stopTyping();
    // Dismiss thinking indicator when the agent starts executing tools
    await this.thinkingIndicator.dismiss();

    // Some agents (gemini) re-emit prior tool_call events on every agentic
    // step — without this guard, each step appears as a fresh Discord message
    // containing every tool call from the entire turn so far. If we've already
    // recorded this tool ID in the previous card, drop the re-emission: any
    // status/content already applied via onToolUpdate is the source of truth,
    // and upserting would clobber it back to "running".
    const prevEntry = this.previousToolStateMap?.get(meta.id);
    if (prevEntry) {
      if (this.previousToolCard) {
        const spec = this.specBuilder.buildToolSpec(prevEntry, this._outputMode, this.sessionContext);
        this.previousToolCard.updateFromSpec(spec);
      }
      return;
    }

    const entry = this.toolStateMap.upsert(meta, kind, rawInput);
    const spec = this.specBuilder.buildToolSpec(entry, this._outputMode, this.sessionContext);
    this.ensureToolCard();
    this.toolCard!.updateFromSpec(spec);
  }

  async onToolUpdate(
    id: string,
    status: string,
    viewerLinks?: ViewerLinks,
    content?: string | null,
    rawInput?: unknown,
    diffStats?: { added: number; removed: number },
  ): Promise<void> {
    // Try previous tool state map first for out-of-order updates
    if (this.previousToolStateMap?.get(id)) {
      this.previousToolStateMap.merge(id, status, rawInput, content, viewerLinks, diffStats);
      const prevEntry = this.previousToolStateMap.get(id);
      if (prevEntry && this.previousToolCard) {
        const prevSpec = this.specBuilder.buildToolSpec(prevEntry, this._outputMode, this.sessionContext);
        this.previousToolCard.updateFromSpec(prevSpec);
      }
      return;
    }

    // Also try current map
    const existed = !!this.toolStateMap.get(id);
    const entry = this.toolStateMap.merge(id, status, rawInput, content, viewerLinks, diffStats);
    if (!existed || !entry) return;

    const spec = this.specBuilder.buildToolSpec(entry, this._outputMode, this.sessionContext);
    this.toolCard?.updateFromSpec(spec);
  }

  async onPlan(entries: PlanEntry[]): Promise<void> {
    this.stopTyping();
    this._currentPlanEntries = entries;
    this.ensureToolCard();
    this.toolCard!.updatePlan(entries);
  }

  async cleanup(): Promise<void> {
    this.stopTyping();
    await this.thinkingIndicator.dismiss();

    if (this.toolCard) {
      this.toolCard.finalize();
      await this.flushPromise;
    }

    if (this.previousToolCard) {
      this.previousToolCard.finalize();
      await this.previousFlushPromise;
    }
  }

  destroy(): void {
    this.stopTyping();
    // Use fire-and-forget dismiss to avoid blocking destroy
    this.thinkingIndicator.dismiss().catch(() => {});
    this.toolCard?.destroy();
    this.previousToolCard?.destroy();
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private ensureToolCard(): void {
    if (this.toolCard && this.toolCard.hasContent()) {
      // Already has a card with content — reuse it
      return;
    }
    if (!this.toolCard) {
      const ref = { isPrevious: false };
      this._currentCardRef = ref;
      this.toolCard = new ToolCardState({
        onFlush: (snapshot) => {
          if (ref.isPrevious) {
            this.previousFlushPromise = this.previousFlushPromise
              .then(() => this.flushToolCard(snapshot, true))
              .catch(() => {});
          } else {
            this.flushPromise = this.flushPromise
              .then(() => this.flushToolCard(snapshot, false))
              .catch(() => {});
          }
        },
      });
    }
  }

  private async sealToolCard(): Promise<void> {
    if (!this.toolCard || !this.toolCard.hasContent()) return;

    this.toolCard.finalize();
    await this.flushPromise;

    // Mark card as previous BEFORE swapping so any late flushes use the right chain
    if (this._currentCardRef) {
      this._currentCardRef.isPrevious = true;
      this._currentCardRef = undefined;
    }

    // Old previous card's link is no longer relevant after this swap
    this._prevThoughtViewerLink = undefined;

    // Swap current → previous
    this.previousToolCard = this.toolCard;
    this.previousToolCardMsg = this.toolCardMsg;
    this.previousToolStateMap = this.toolStateMap;
    this.previousFlushPromise = this.flushPromise;

    // Fresh state
    this.toolStateMap = new ToolStateMap();
    this.toolCard = undefined;
    this.toolCardMsg = undefined;
    this.flushPromise = Promise.resolve();
    this._currentPlanEntries = undefined;
  }

  private async flushToolCard(
    snapshot: ToolCardSnapshot,
    isPrevious: boolean,
  ): Promise<void> {
    const thoughtViewerLink = isPrevious ? this._prevThoughtViewerLink : undefined;
    const { embeds, components } = renderToolCard(snapshot, this._outputMode, this.sessionId, thoughtViewerLink);

    if (embeds.length === 0) return;

    const msg = isPrevious ? this.previousToolCardMsg : this.toolCardMsg;

    try {
      if (msg) {
        await this.sendQueue.enqueue(
          () => msg.edit({ embeds, components }),
          { type: "other" },
        );
      } else {
        const result = await this.sendQueue.enqueue(
          () => this.channel.send({ embeds, components }),
          { type: "other" },
        );
        if (result) {
          if (isPrevious) {
            this.previousToolCardMsg = result as Message;
          } else {
            this.toolCardMsg = result as Message;
          }
        }
      }
    } catch {
      // Swallow errors — Discord API failures shouldn't break the tracker
    }
  }

  private async startTyping(): Promise<void> {
    if (this.typingDismissed) return;
    // Skip if already active — onThought fires on every chunk, so without this
    // guard each thought event would trigger a separate sendTyping() call and
    // quickly exhaust Discord's rate limit on /channels/:id/typing.
    if (this.typingRefreshTimer) return;

    try {
      await this.channel.sendTyping();
    } catch {
      // ignore
    }

    // Re-check after the async call in case typing was stopped while awaiting
    if (this.typingDismissed) return;

    this.typingRefreshTimer = setInterval(() => {
      if (this.typingDismissed) {
        this.stopTypingTimer();
        return;
      }
      this.channel.sendTyping().catch(() => {});
    }, TYPING_REFRESH_MS);
  }

  private stopTyping(): void {
    this.typingDismissed = true;
    this.stopTypingTimer();
  }

  private stopTypingTimer(): void {
    if (this.typingRefreshTimer) {
      clearInterval(this.typingRefreshTimer);
      this.typingRefreshTimer = undefined;
    }
  }
}
