import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

// TODO: Import these from @openacp/plugin-sdk once the SDK is updated with
// the new OutputMode / ToolDisplaySpec / ToolCardSnapshot exports.
// For now, defined locally to unblock development.

export type OutputMode = "low" | "medium" | "high";

export interface ToolDisplaySpec {
  id: string;
  kind: string;
  icon: string;
  title: string;
  description: string | null;
  command: string | null;
  inputContent: string | null;
  outputSummary: string | null;
  outputContent: string | null;
  diffStats: { added: number; removed: number } | null;
  viewerLinks?: { file?: string; diff?: string };
  outputViewerLink?: string;
  outputFallbackContent?: string;
  status: string;
  isNoise: boolean;
  isHidden: boolean;
}

export interface PlanEntry {
  content: string;
  status: string;
  priority: string;
}

export interface ToolCardSnapshot {
  specs: ToolDisplaySpec[];
  planEntries?: PlanEntry[];
  usage?: { tokensUsed?: number; contextSize?: number; cost?: number };
  totalVisible: number;
  completedVisible: number;
  allComplete: boolean;
}

export interface ToolCardResult {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

// ─── Constants (local copies; TODO: import from @openacp/plugin-sdk/formatting) ─

const STATUS_ICONS: Record<string, string> = {
  pending: "⏳",
  in_progress: "🔄",
  completed: "✅",
  failed: "❌",
  cancelled: "🚫",
  running: "🔄",
  done: "✅",
  error: "❌",
};

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

const KIND_LABELS: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  delete: "Delete",
  execute: "Run",
  bash: "Bash",
  command: "Run",
  terminal: "Terminal",
  search: "Search",
  web: "Web",
  fetch: "Fetch",
  agent: "Agent",
  think: "Agent",
  install: "Install",
  move: "Move",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function progressBar(ratio: number, length = 10): string {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * length);
  return "▓".repeat(filled) + "░".repeat(length - filled);
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const TRUNCATION_SUFFIX = "… (truncated)";

function truncateContent(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

// ─── Embed color constants ──────────────────────────────────────────────────

const COLOR_BLUE = 0x3498db;
const COLOR_GREEN = 0x2ecc71;
const COLOR_RED = 0xe74c3c;
const COLOR_DARK_GRAY = 0x2f3136;
const COLOR_YELLOW = 0xf1c40f;

const ERROR_STATUSES = new Set(["error", "failed"]);
const LOW_MODE_COLUMNS = 3;
const INLINE_OUTPUT_MAX = 800;

/**
 * Tool kinds whose title is "code-y" user content (file paths, shell commands,
 * search patterns) and should render as monospace inline code rather than bold.
 * Excludes kinds where the title is a descriptive label like "Update Topic
 * Context" or "Invoke Subagent" — those stay bold.
 */
const CODEY_KINDS = new Set([
  "execute", "bash", "command", "terminal",
  "read", "edit", "write", "delete", "search",
]);

// ─── renderSpecSection ──────────────────────────────────────────────────────

export function renderSpecSection(spec: ToolDisplaySpec, mode: OutputMode): string {
  const statusIcon = STATUS_ICONS[spec.status] ?? "🔧";
  const kindIcon = spec.icon || KIND_ICONS[spec.kind] || "🔧";
  const kindLabel = KIND_LABELS[spec.kind] || "";

  if (mode === "low") {
    return `${statusIcon} ${kindIcon} ${kindLabel || spec.title}`;
  }

  // Medium and high share the same base structure
  const lines: string[] = [];

  // Title line: noise tools use 👁️ instead of status icon
  const leadIcon = spec.isNoise && mode === "high" ? "👁️" : statusIcon;
  // For tools whose title is code-y user content — file paths, search patterns,
  // shell commands — render as inline `code` (monospace, no markdown
  // interpretation). Tools whose title is a descriptive label ("Update Topic
  // Context", "Invoke Subagent") stay bold.
  const titleText = CODEY_KINDS.has(spec.kind) ? `\`${spec.title}\`` : `**${spec.title}**`;
  const titleLine = `${leadIcon} ${kindIcon} ${titleText}`;
  lines.push(titleLine);

  // Description line
  if (spec.description) {
    lines.push(` ╰ ${spec.description}`);
  }

  // Diff stats + viewer link line
  const diffParts: string[] = [];
  if (spec.diffStats) {
    const { added, removed } = spec.diffStats;
    if (added > 0 && removed > 0) diffParts.push(`+${added}/-${removed} lines`);
    else if (added > 0) diffParts.push(`+${added} lines`);
    else if (removed > 0) diffParts.push(`-${removed} lines`);
  }
  if (spec.viewerLinks?.diff) {
    diffParts.push(`[View Diff](${spec.viewerLinks.diff})`);
  }
  if (spec.viewerLinks?.file) {
    diffParts.push(`[View File](${spec.viewerLinks.file})`);
  }
  if (diffParts.length > 0) {
    lines.push(` ╰ ${diffParts.join(" · ")}`);
  }

  // Medium mode: show output summary if no inline content
  if (spec.outputSummary && !spec.outputContent) {
    lines.push(` ╰ ${spec.outputSummary}`);
  }

  // High mode extras: inline output, output viewer link
  if (mode === "high") {
    if (spec.outputContent || spec.outputFallbackContent) {
      const raw = spec.outputContent ?? spec.outputFallbackContent!;
      const truncated = truncateContent(raw, INLINE_OUTPUT_MAX);
      lines.push(`\`\`\`\n${truncated}\n\`\`\``);
    }
    if (spec.outputViewerLink) {
      lines.push(`[View output](${spec.outputViewerLink})`);
    }
  }

  return lines.join("\n");
}

// ─── splitToolCardDescription ───────────────────────────────────────────────

const EMBED_DESC_LIMIT = 4096;

export function splitToolCardDescription(text: string): string[] {
  if (text.length <= EMBED_DESC_LIMIT) return [text];

  const sections = text.split("\n\n");
  const chunks: string[] = [];
  let current = "";

  for (const section of sections) {
    // Handle a single section that exceeds the limit
    const safeSection =
      section.length > EMBED_DESC_LIMIT
        ? section.slice(0, EMBED_DESC_LIMIT - 3) + "..."
        : section;

    const candidate = current ? `${current}\n\n${safeSection}` : safeSection;
    if (candidate.length > EMBED_DESC_LIMIT && current) {
      chunks.push(current);
      current = safeSection;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ─── renderToolCard ─────────────────────────────────────────────────────────

export function renderToolCard(
  snapshot: ToolCardSnapshot,
  mode: OutputMode,
  sessionId?: string,
  thoughtViewerLink?: string,
): ToolCardResult {
  const { specs, totalVisible, completedVisible, allComplete } = snapshot;

  // Filter hidden specs
  const visible = specs.filter((s) => !s.isHidden);

  // Determine embed color
  const hasError = visible.some((s) => ERROR_STATUSES.has(s.status));
  const color = hasError ? COLOR_RED : allComplete ? COLOR_GREEN : COLOR_BLUE;

  // Author line
  const authorName = allComplete
    ? `✅ Done ${completedVisible}/${totalVisible}`
    : `🔄 Working... ${completedVisible} of ${totalVisible}`;

  // Build description from spec sections
  const sections = visible.map((s) => renderSpecSection(s, mode));
  let description: string;

  if (mode === "low") {
    // Compact grid: 3 per line with " · " separators
    const lines: string[] = [];
    for (let i = 0; i < sections.length; i += LOW_MODE_COLUMNS) {
      lines.push(sections.slice(i, i + LOW_MODE_COLUMNS).join(" · "));
    }
    description = lines.join("\n");
  } else {
    description = sections.join("\n\n");
  }

  // Plan rendering
  if (snapshot.planEntries && snapshot.planEntries.length > 0) {
    const entries = snapshot.planEntries;
    if (mode === "high") {
      // Full plan list in description
      const planLines = entries.map(
        (e, i) => `${STATUS_ICONS[e.status] ?? "⬜"} ${i + 1}. ${e.content}`,
      );
      description += "\n\n📋 **Plan:**\n" + planLines.join("\n");
    }
  }

  // Thought viewer link (high mode only)
  if (mode === "high" && thoughtViewerLink) {
    description += `\n\n💭 [View Thinking](${thoughtViewerLink})`;
  }

  // If description is empty (no visible specs, no plan text), return empty result
  if (!description) {
    return { embeds: [], components: [] };
  }

  // Split description into multiple embeds if needed
  const descChunks = splitToolCardDescription(description);
  const embeds: EmbedBuilder[] = [];

  for (let i = 0; i < descChunks.length; i++) {
    const embed = new EmbedBuilder().setColor(color).setDescription(descChunks[i]);

    // Only the first embed gets the author line
    if (i === 0) {
      embed.setAuthor({ name: authorName });
    }

    // Footer on the last embed: plan progress for medium mode
    if (i === descChunks.length - 1 && mode === "medium" && snapshot.planEntries?.length) {
      const entries = snapshot.planEntries;
      const currentIdx = entries.findIndex((e) => e.status === "in_progress");
      const stepNum = currentIdx >= 0 ? currentIdx + 1 : entries.filter((e) => e.status === "completed").length + 1;
      const currentLabel = currentIdx >= 0 ? entries[currentIdx].content : entries[Math.min(stepNum - 1, entries.length - 1)]?.content ?? "";
      embed.setFooter({ text: `📋 Step ${stepNum}/${entries.length} — ${currentLabel}` });
    }

    embeds.push(embed);
  }

  // Action row (only while running, only if sessionId provided)
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (!allComplete && sessionId) {
    const row = new ActionRowBuilder<ButtonBuilder>();

    const modes: OutputMode[] = ["low", "medium", "high"];
    const modeLabels: Record<OutputMode, string> = {
      low: "🔇 Low",
      medium: "📊 Medium",
      high: "🔍 High",
    };

    for (const m of modes) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`om:${sessionId}:${m}`)
          .setLabel(modeLabels[m])
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(m === mode),
      );
    }

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`cancel:${sessionId}`)
        .setLabel("❌ Cancel")
        .setStyle(ButtonStyle.Danger),
    );

    components.push(row);
  }

  return { embeds, components };
}

// ─── renderUsageEmbed ───────────────────────────────────────────────────────

interface UsageData {
  tokensUsed?: number;
  contextSize?: number;
  cost?: number;
  duration?: number;
}

export function renderUsageEmbed(usage: UsageData, mode: OutputMode): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLOR_DARK_GRAY);

  const { tokensUsed, contextSize, cost, duration } = usage;

  if (tokensUsed == null) {
    embed.setDescription("📊 Usage data unavailable");
    return embed;
  }

  const durationStr = duration != null ? `${duration}s` : null;

  if (mode === "low") {
    const parts = [`📊 ${formatTokens(tokensUsed)} tokens`];
    if (durationStr) parts.push(durationStr);
    embed.setDescription(parts.join(" · "));
    return embed;
  }

  if (mode === "medium") {
    const line1Parts = [`📊 ${formatTokens(tokensUsed)} tokens`];
    if (cost != null) line1Parts.push(`$${cost.toFixed(2)}`);
    const lines = [line1Parts.join(" · ")];
    if (durationStr) lines.push(`⏱️ ${durationStr}`);
    embed.setDescription(lines.join("\n"));
    return embed;
  }

  // High mode: full with progress bar
  if (contextSize == null) {
    embed.setDescription(`📊 ${formatTokens(tokensUsed)} tokens`);
    return embed;
  }

  const ratio = tokensUsed / contextSize;
  const pct = Math.round(ratio * 100);
  const bar = progressBar(ratio);
  const emoji = pct >= 85 ? "⚠️" : "📊";

  const lines = [`${emoji} ${formatTokens(tokensUsed)} / ${formatTokens(contextSize)} tokens`, `${bar} ${pct}%`];
  if (cost != null) lines.push(`💰 $${cost.toFixed(2)}`);
  if (durationStr) lines.push(`⏱️ ${durationStr}`);

  embed.setDescription(lines.join("\n"));
  return embed;
}

// ─── renderPermissionEmbed ──────────────────────────────────────────────────

interface PermissionRequest {
  toolName: string;
  command?: string;
  description?: string;
}

// ─── Backward-compatible re-exports ─────────────────────────────────────────
// These are used by other modules (renderer.ts, streaming.ts, etc.) that still
// reference the old API. They will be removed when those modules are rewritten.

// Legacy ToolCallMeta interface (inline to avoid SDK runtime import issues)
interface LegacyToolCallMeta {
  id: string;
  name: string;
  kind?: string;
  status?: string;
  content?: unknown;
  rawInput?: unknown;
  viewerLinks?: { file?: string; diff?: string };
  viewerFilePath?: string;
  displaySummary?: string;
  displayTitle?: string;
  displayKind?: string;
}

type LegacyVerbosity = "low" | "medium" | "high";

function legacyResolveToolIcon(tool: LegacyToolCallMeta): string {
  if (tool.status && STATUS_ICONS[tool.status]) return STATUS_ICONS[tool.status];
  if (tool.displayKind && KIND_ICONS[tool.displayKind]) return KIND_ICONS[tool.displayKind];
  if (tool.kind && KIND_ICONS[tool.kind]) return KIND_ICONS[tool.kind];
  return "🔧";
}

function legacyFormatTitle(name: string, rawInput: unknown, displayTitle?: string): string {
  if (displayTitle) return displayTitle;
  return name;
}

function legacyFormatSummary(name: string, rawInput: unknown, displaySummary?: string): string {
  if (displaySummary) return displaySummary;
  if (rawInput && typeof rawInput === "object") {
    const input = rawInput as Record<string, unknown>;
    // Search tools: show pattern
    if (input.pattern) return `${KIND_ICONS[name.toLowerCase()] || "🔍"} ${name} "${input.pattern}"`;
    // File tools: show path
    if (input.file_path) return `${name} ${input.file_path}`;
  }
  return name;
}

function extractContentTextLegacy(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c) return String(c.text);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object" && content !== null && "text" in content) {
    return String((content as { text: unknown }).text);
  }
  return "";
}

function stripCodeFencesLegacy(text: string): string {
  return text.replace(/^```[\w]*\n?/gm, "").replace(/\n?```$/gm, "");
}

function formatViewerLinksLegacy(links?: { file?: string; diff?: string }, filePath?: string): string {
  if (!links) return "";
  const fileName = filePath ? filePath.split("/").pop() || filePath : "";
  let text = "\n";
  if (links.file) text += `\n[View ${fileName || "file"}](${links.file})`;
  if (links.diff)
    text += `\n[View diff${fileName ? ` — ${fileName}` : ""}](${links.diff})`;
  return text;
}

function formatHighDetailsLegacy(
  rawInput: unknown,
  content: unknown,
  maxLen: number,
): string {
  let text = "";
  if (rawInput) {
    const inputStr =
      typeof rawInput === "string"
        ? rawInput
        : JSON.stringify(rawInput, null, 2);
    if (inputStr && inputStr !== "{}") {
      text += `\n**Input:**\n\`\`\`\n${truncateContent(inputStr, maxLen)}\n\`\`\``;
    }
  }
  const details = stripCodeFencesLegacy(extractContentTextLegacy(content));
  if (details) {
    text += `\n**Output:**\n\`\`\`\n${truncateContent(details, maxLen)}\n\`\`\``;
  }
  return text;
}

function splitMessageImpl(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  // Split at paragraph boundaries first; for paragraphs that are individually
  // too long, fall back to line-splitting; for single lines that are too long,
  // fall back to hard-character splitting. All content must reach a chunk —
  // never truncate-and-drop.
  const paragraphs = text.split("\n\n");
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) { chunks.push(current); current = ""; }
  };

  const pushLines = (para: string) => {
    const lines = para.split("\n");
    for (const line of lines) {
      if (line.length > maxLength) {
        // Single line too long — hard split by characters so nothing is lost.
        flush();
        for (let i = 0; i < line.length; i += maxLength) {
          chunks.push(line.slice(i, i + maxLength));
        }
        continue;
      }
      const lineCandidate = current ? `${current}\n${line}` : line;
      if (lineCandidate.length > maxLength) {
        flush();
        current = line;
      } else {
        current = lineCandidate;
      }
    }
  };

  for (const para of paragraphs) {
    if (para.length > maxLength) {
      // Paragraph alone exceeds the limit — flush whatever we've buffered
      // and split this paragraph by lines so the full content survives.
      flush();
      pushLines(para);
      continue;
    }
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > maxLength) {
      flush();
      current = para;
    } else {
      current = candidate;
    }
  }
  flush();
  return balanceCodeFences(chunks);
}

/**
 * Close any open ``` fence at the end of each chunk and re-open it at the
 * start of the next (with the same language tag if any). Without this, a long
 * fenced block split across Discord messages renders with the continuation
 * as raw text.
 *
 * Implementation: walk fences in order, tracking which fence (if any) is
 * currently open via state machine. Whatever's open at the end of a chunk
 * is what needs to be re-opened in the next chunk — with one nuance for
 * untagged fences:
 *
 *   - TAGGED open (e.g. ```python) at chunk end: always carry forward.
 *     Losing a language tag across a split is the worst-case outcome.
 *
 *   - UNTAGGED open (bare ```) at chunk end: carry forward ONLY if the chunk
 *     has content after the trailing fence. A bare ``` as the last non-blank
 *     line is more likely an LLM emitting a dangling/orphan close (after a
 *     balanced block) than the start of a new code block. Carrying that
 *     untagged fence into the next chunk would corrupt any later language
 *     tag (e.g. prepending ``` in front of a ```python that should stay).
 */
function balanceCodeFences(chunks: string[]): string[] {
  // Triple-backtick at start of a line, optionally followed by a language tag.
  const FENCE_RE = /^```[a-zA-Z0-9_-]*/gm;
  // Anchored variant for "this whole line is a fence" check.
  const FENCE_LINE_RE = /^```[a-zA-Z0-9_-]*$/;

  const result: string[] = [];
  let pendingOpenFence: string | null = null;

  for (let chunk of chunks) {
    if (pendingOpenFence !== null) {
      chunk = `${pendingOpenFence}\n${chunk}`;
      pendingOpenFence = null;
    }

    // Walk fences in order, toggling the currently-open fence.
    let openFence: string | null = null;
    for (const fence of chunk.match(FENCE_RE) ?? []) {
      openFence = openFence === null ? fence : null;
    }

    if (openFence !== null) {
      // Decide whether to carry forward BEFORE we mutate the chunk.
      let shouldCarry: boolean;
      if (openFence.length > 3) {
        // Tagged open — always carry forward.
        shouldCarry = true;
      } else {
        // Untagged open — only carry if there's content after the trailing
        // fence (i.e., the chunk genuinely splits a fenced block mid-content).
        const lines = chunk.split("\n");
        let i = lines.length - 1;
        while (i >= 0 && lines[i].trim() === "") i--;
        shouldCarry = i >= 0 && !FENCE_LINE_RE.test(lines[i]);
      }

      // Close the chunk so it renders as a self-contained block either way.
      chunk = `${chunk}\n\`\`\``;
      if (shouldCarry) pendingOpenFence = openFence;
    }

    result.push(chunk);
  }

  return result;
}

/** @deprecated Use renderToolCard instead */
export function formatToolCall(
  tool: LegacyToolCallMeta,
  verbosity: LegacyVerbosity = "medium",
): string {
  const si = legacyResolveToolIcon(tool);
  const name = tool.name || "Tool";
  const label =
    verbosity === "low"
      ? legacyFormatTitle(name, tool.rawInput, tool.displayTitle)
      : legacyFormatSummary(name, tool.rawInput, tool.displaySummary);
  let text = `${si} **${label}**`;
  text += formatViewerLinksLegacy(tool.viewerLinks, tool.viewerFilePath);
  if (verbosity === "high") {
    text += formatHighDetailsLegacy(tool.rawInput, tool.content, 500);
  }
  return text;
}

/** @deprecated Use renderToolCard instead */
export function formatToolUpdate(
  update: LegacyToolCallMeta,
  verbosity: LegacyVerbosity = "medium",
): string {
  return formatToolCall(update, verbosity);
}

/** @deprecated Use renderToolCard plan rendering instead */
export function formatPlan(
  entries: PlanEntry[],
  verbosity: LegacyVerbosity = "medium",
): string {
  if (verbosity === "medium") {
    const done = entries.filter((e) => e.status === "completed").length;
    return `📋 **Plan:** ${done}/${entries.length} steps completed`;
  }
  const statusIconMap: Record<string, string> = {
    pending: "⏳",
    in_progress: "🔄",
    completed: "✅",
  };
  const lines = entries.map(
    (e, i) => `${statusIconMap[e.status] || "⬜"} ${i + 1}. ${e.content}`,
  );
  return `**Plan:**\n${lines.join("\n")}`;
}

/** @deprecated Use renderUsageEmbed instead */
export function formatUsage(
  usage: { tokensUsed?: number; contextSize?: number; cost?: number },
  verbosity: LegacyVerbosity = "medium",
): string {
  const { tokensUsed, contextSize, cost } = usage;
  if (tokensUsed == null) return "📊 Usage data unavailable";
  if (verbosity === "medium") {
    const costStr = cost != null ? ` · $${cost.toFixed(2)}` : "";
    return `📊 ${formatTokens(tokensUsed)} tokens${costStr}`;
  }
  if (contextSize == null) return `📊 ${formatTokens(tokensUsed)} tokens`;
  const ratio = tokensUsed / contextSize;
  const pct = Math.round(ratio * 100);
  const bar = progressBar(ratio);
  const emoji = pct >= 85 ? "⚠️" : "📊";
  let text = `${emoji} ${formatTokens(tokensUsed)} / ${formatTokens(contextSize)} tokens\n${bar} ${pct}%`;
  if (cost != null) text += `\n💰 $${cost.toFixed(2)}`;
  return text;
}

/** @deprecated Use splitToolCardDescription instead */
export function splitMessage(text: string, maxLength = 1800): string[] {
  return splitMessageImpl(text, maxLength);
}

// ─── renderPermissionEmbed ──────────────────────────────────────────────────

export function renderPermissionEmbed(
  request: PermissionRequest,
  sessionId: string,
  callbackKey: string,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder()
    .setColor(COLOR_YELLOW)
    .setAuthor({ name: "🔐 Permission Request" });

  const descLines: string[] = [];
  descLines.push(`**Tool:** ${request.toolName}`);
  if (request.command) {
    descLines.push(`**Command:** \`${request.command}\``);
  }
  if (request.description) {
    descLines.push(`\n${request.description}`);
  }
  embed.setDescription(descLines.join("\n"));

  const prefix = `p:${sessionId}:${callbackKey}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:allow`)
      .setLabel("Allow")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${prefix}:deny`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${prefix}:always`)
      .setLabel("Always Allow")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}
