import { describe, it, expect } from "vitest";
import {
  renderSpecSection,
  renderToolCard,
  renderUsageEmbed,
  renderPermissionEmbed,
  splitMessage,
  splitToolCardDescription,
} from "../formatting.js";
import type { OutputMode, ToolDisplaySpec, ToolCardSnapshot } from "../formatting.js";
import { EmbedBuilder, ButtonStyle } from "discord.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<ToolDisplaySpec> = {}): ToolDisplaySpec {
  return {
    id: "tool-1",
    kind: "read",
    icon: "📖",
    title: "main.ts",
    description: null,
    command: null,
    inputContent: null,
    outputSummary: null,
    outputContent: null,
    diffStats: null,
    status: "completed",
    isNoise: false,
    isHidden: false,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ToolCardSnapshot> = {}): ToolCardSnapshot {
  return {
    specs: [makeSpec()],
    totalVisible: 1,
    completedVisible: 1,
    allComplete: true,
    ...overrides,
  };
}

// ─── renderSpecSection ──────────────────────────────────────────────────────

describe("renderSpecSection", () => {
  describe("low mode", () => {
    it("returns compact format with status + kind icon + kind label", () => {
      const result = renderSpecSection(makeSpec(), "low");
      expect(result).toContain("✅");
      expect(result).toContain("📖");
      expect(result).toContain("Read");
    });

    it("uses running icon for running status", () => {
      const result = renderSpecSection(makeSpec({ status: "running" }), "low");
      expect(result).toContain("🔄");
    });

    it("uses error icon for failed status", () => {
      const result = renderSpecSection(makeSpec({ status: "error" }), "low");
      expect(result).toContain("❌");
    });

    it("does not include description or diff stats", () => {
      const result = renderSpecSection(
        makeSpec({
          description: "Some description",
          diffStats: { added: 5, removed: 3 },
        }),
        "low",
      );
      expect(result).not.toContain("Some description");
      expect(result).not.toContain("+5");
    });
  });

  describe("medium mode", () => {
    it("shows status icon, kind icon, bold title", () => {
      const result = renderSpecSection(makeSpec({ title: "config.ts" }), "medium");
      expect(result).toContain("✅");
      expect(result).toContain("📖");
      expect(result).toContain("**config.ts**");
    });

    it("shows description on second line with vine character", () => {
      const result = renderSpecSection(
        makeSpec({ description: "Reading file contents" }),
        "medium",
      );
      expect(result).toContain("╰");
      expect(result).toContain("Reading file contents");
    });

    it("shows diff stats and viewer link", () => {
      const result = renderSpecSection(
        makeSpec({
          kind: "edit",
          icon: "✏️",
          title: "utils.ts",
          diffStats: { added: 10, removed: 3 },
          viewerLinks: { diff: "https://example.com/diff" },
        }),
        "medium",
      );
      expect(result).toContain("+10/-3");
      expect(result).toContain("[View Diff](https://example.com/diff)");
    });

    it("shows only added lines when no removed", () => {
      const result = renderSpecSection(
        makeSpec({ diffStats: { added: 5, removed: 0 } }),
        "medium",
      );
      expect(result).toContain("+5");
      expect(result).not.toContain("-0");
    });

    it("shows only removed lines when no added", () => {
      const result = renderSpecSection(
        makeSpec({ diffStats: { added: 0, removed: 7 } }),
        "medium",
      );
      expect(result).toContain("-7");
      expect(result).not.toContain("+0");
    });

    it("does not include inline output content", () => {
      const result = renderSpecSection(
        makeSpec({ outputContent: "some output text" }),
        "medium",
      );
      expect(result).not.toContain("```");
      expect(result).not.toContain("some output text");
    });
  });

  describe("high mode", () => {
    it("includes same info as medium", () => {
      const result = renderSpecSection(
        makeSpec({ description: "desc" }),
        "high",
      );
      expect(result).toContain("✅");
      expect(result).toContain("📖");
      expect(result).toContain("**main.ts**");
      expect(result).toContain("desc");
    });

    it("includes inline output content in code blocks", () => {
      const result = renderSpecSection(
        makeSpec({ outputContent: "const x = 1;" }),
        "high",
      );
      expect(result).toContain("```");
      expect(result).toContain("const x = 1;");
    });

    it("includes output fallback content when no outputContent", () => {
      const result = renderSpecSection(
        makeSpec({ outputFallbackContent: "fallback text" }),
        "high",
      );
      expect(result).toContain("```");
      expect(result).toContain("fallback text");
    });

    it("includes output viewer link", () => {
      const result = renderSpecSection(
        makeSpec({ outputViewerLink: "https://example.com/output" }),
        "high",
      );
      expect(result).toContain("[View output](https://example.com/output)");
    });

    it("shows noise tools with eye icon", () => {
      const result = renderSpecSection(
        makeSpec({ isNoise: true, title: "list_files" }),
        "high",
      );
      expect(result).toContain("👁️");
    });

    it("does not show noise indicator in medium mode", () => {
      const result = renderSpecSection(
        makeSpec({ isNoise: true, title: "list_files" }),
        "medium",
      );
      expect(result).not.toContain("👁️");
    });
  });

  it("falls back gracefully when kind has no label", () => {
    const result = renderSpecSection(
      makeSpec({ kind: "unknown_kind", icon: "🔧", title: "mystery" }),
      "medium",
    );
    expect(result).toContain("mystery");
  });
});

// ─── renderToolCard ─────────────────────────────────────────────────────────

describe("renderToolCard", () => {
  describe("embed color", () => {
    it("uses blue while running", () => {
      const result = renderToolCard(
        makeSnapshot({
          allComplete: false,
          completedVisible: 1,
          totalVisible: 3,
          specs: [
            makeSpec({ status: "completed" }),
            makeSpec({ id: "t2", status: "running" }),
            makeSpec({ id: "t3", status: "running" }),
          ],
        }),
        "medium",
      );
      expect(result.embeds[0].data.color).toBe(0x3498db);
    });

    it("uses green when all done", () => {
      const result = renderToolCard(makeSnapshot(), "medium");
      expect(result.embeds[0].data.color).toBe(0x2ecc71);
    });

    it("uses red when any spec has error", () => {
      const result = renderToolCard(
        makeSnapshot({
          specs: [makeSpec({ status: "error" })],
          allComplete: true,
        }),
        "medium",
      );
      expect(result.embeds[0].data.color).toBe(0xe74c3c);
    });
  });

  describe("author line", () => {
    it("shows working status with counter when running", () => {
      const result = renderToolCard(
        makeSnapshot({
          allComplete: false,
          completedVisible: 2,
          totalVisible: 4,
        }),
        "medium",
      );
      const author = result.embeds[0].data.author;
      expect(author?.name).toContain("Working");
      expect(author?.name).toContain("2 of 4");
    });

    it("shows done status with counter when complete", () => {
      const result = renderToolCard(
        makeSnapshot({
          allComplete: true,
          completedVisible: 4,
          totalVisible: 4,
        }),
        "medium",
      );
      const author = result.embeds[0].data.author;
      expect(author?.name).toContain("Done");
      expect(author?.name).toContain("4/4");
    });
  });

  describe("hidden spec filtering", () => {
    it("filters out hidden specs from description", () => {
      const result = renderToolCard(
        makeSnapshot({
          specs: [
            makeSpec({ title: "visible.ts" }),
            makeSpec({ id: "t2", title: "hidden.ts", isHidden: true }),
          ],
        }),
        "medium",
      );
      const desc = result.embeds[0].data.description ?? "";
      expect(desc).toContain("visible.ts");
      expect(desc).not.toContain("hidden.ts");
    });
  });

  describe("action row", () => {
    it("includes action row with buttons when running and sessionId provided", () => {
      const result = renderToolCard(
        makeSnapshot({ allComplete: false }),
        "medium",
        "sess-123",
      );
      expect(result.components.length).toBe(1);
      // Should have mode buttons + cancel button
      const buttons = result.components[0].components;
      expect(buttons.length).toBeGreaterThanOrEqual(4); // low, medium, high, cancel
    });

    it("disables the current mode button", () => {
      const result = renderToolCard(
        makeSnapshot({ allComplete: false }),
        "medium",
        "sess-123",
      );
      const buttons = result.components[0].components;
      // The medium button should be disabled
      const mediumBtn = buttons.find(
        (b: any) => b.data.custom_id === "om:sess-123:medium",
      );
      expect(mediumBtn).toBeDefined();
      expect((mediumBtn as any).data.disabled).toBe(true);
    });

    it("does not include action row when complete", () => {
      const result = renderToolCard(makeSnapshot(), "medium", "sess-123");
      expect(result.components.length).toBe(0);
    });

    it("does not include action row when no sessionId", () => {
      const result = renderToolCard(
        makeSnapshot({ allComplete: false }),
        "medium",
      );
      expect(result.components.length).toBe(0);
    });

    it("includes cancel button with correct customId", () => {
      const result = renderToolCard(
        makeSnapshot({ allComplete: false }),
        "low",
        "sess-abc",
      );
      const buttons = result.components[0].components;
      const cancelBtn = buttons.find(
        (b: any) => b.data.custom_id === "cancel:sess-abc",
      );
      expect(cancelBtn).toBeDefined();
    });
  });

  describe("low mode grid layout", () => {
    it("joins specs with separator, 3 per line", () => {
      const specs = Array.from({ length: 5 }, (_, i) =>
        makeSpec({ id: `t${i}`, title: `file${i}.ts`, status: "completed" }),
      );
      const result = renderToolCard(
        makeSnapshot({ specs, totalVisible: 5, completedVisible: 5 }),
        "low",
      );
      const desc = result.embeds[0].data.description ?? "";
      // Should have " · " separators within lines
      expect(desc).toContain(" · ");
    });
  });

  describe("medium/high mode sections", () => {
    it("joins sections with double newlines", () => {
      const specs = [
        makeSpec({ id: "t1", title: "first.ts" }),
        makeSpec({ id: "t2", title: "second.ts" }),
      ];
      const result = renderToolCard(
        makeSnapshot({ specs, totalVisible: 2, completedVisible: 2 }),
        "medium",
      );
      const desc = result.embeds[0].data.description ?? "";
      expect(desc).toContain("\n\n");
    });
  });

  describe("plan footer", () => {
    it("shows compact plan in footer for medium mode", () => {
      const result = renderToolCard(
        makeSnapshot({
          planEntries: [
            { content: "First step", status: "completed", priority: "high" },
            { content: "Current step", status: "in_progress", priority: "medium" },
            { content: "Future step", status: "pending", priority: "low" },
          ],
        }),
        "medium",
      );
      const footer = result.embeds[0].data.footer?.text ?? "";
      expect(footer).toContain("Step 2/3");
      expect(footer).toContain("Current step");
    });

    it("shows full plan list in description for high mode", () => {
      const result = renderToolCard(
        makeSnapshot({
          planEntries: [
            { content: "First step", status: "completed", priority: "high" },
            { content: "Current step", status: "in_progress", priority: "medium" },
          ],
        }),
        "high",
      );
      const desc = result.embeds[0].data.description ?? "";
      expect(desc).toContain("First step");
      expect(desc).toContain("Current step");
    });
  });

  describe("description splitting", () => {
    it("splits into multiple embeds when description exceeds 4096 chars", () => {
      const specs = Array.from({ length: 50 }, (_, i) =>
        makeSpec({
          id: `t${i}`,
          title: `very-long-file-name-${i}.ts`,
          description: "A ".repeat(50),
          outputContent: "x".repeat(80),
          status: "completed",
        }),
      );
      const result = renderToolCard(
        makeSnapshot({ specs, totalVisible: 50, completedVisible: 50 }),
        "high",
      );
      if (result.embeds.length > 1) {
        for (const embed of result.embeds) {
          expect((embed.data.description ?? "").length).toBeLessThanOrEqual(4096);
        }
      }
    });
  });
});

// ─── splitToolCardDescription ───────────────────────────────────────────────

describe("splitToolCardDescription", () => {
  it("returns single element for text within limit", () => {
    const text = "Hello world";
    expect(splitToolCardDescription(text)).toEqual([text]);
  });

  it("returns single element for text exactly at limit", () => {
    const text = "x".repeat(4096);
    expect(splitToolCardDescription(text)).toEqual([text]);
  });

  it("splits at section boundaries when over limit", () => {
    const section1 = "A".repeat(3000);
    const section2 = "B".repeat(3000);
    const text = section1 + "\n\n" + section2;
    const chunks = splitToolCardDescription(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain("A");
    expect(chunks[1]).toContain("B");
  });

  it("each chunk respects 4096 char limit", () => {
    const sections = Array.from({ length: 10 }, (_, i) => `Section ${i}: ${"x".repeat(1000)}`);
    const text = sections.join("\n\n");
    const chunks = splitToolCardDescription(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it("handles single section over limit by truncating", () => {
    const text = "x".repeat(5000);
    const chunks = splitToolCardDescription(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});

// ─── renderUsageEmbed ───────────────────────────────────────────────────────

describe("renderUsageEmbed", () => {
  it("uses dark gray color", () => {
    const embed = renderUsageEmbed(
      { tokensUsed: 5000, contextSize: 200000 },
      "low",
    );
    expect(embed.data.color).toBe(0x2f3136);
  });

  describe("low mode", () => {
    it("shows compact tokens and duration", () => {
      const embed = renderUsageEmbed(
        { tokensUsed: 5000, duration: 12.5 },
        "low",
      );
      const desc = embed.data.description ?? "";
      expect(desc).toContain("5k tokens");
      expect(desc).toContain("12.5s");
    });
  });

  describe("medium mode", () => {
    it("shows tokens, cost, and duration", () => {
      const embed = renderUsageEmbed(
        { tokensUsed: 28000, cost: 0.25, duration: 30 },
        "medium",
      );
      const desc = embed.data.description ?? "";
      expect(desc).toContain("28k tokens");
      expect(desc).toContain("$0.25");
      expect(desc).toContain("30s");
    });
  });

  describe("high mode", () => {
    it("shows full progress bar and context percentage", () => {
      const embed = renderUsageEmbed(
        { tokensUsed: 85000, contextSize: 100000, cost: 1.5, duration: 60 },
        "high",
      );
      const desc = embed.data.description ?? "";
      expect(desc).toContain("▓");
      expect(desc).toContain("85%");
      expect(desc).toContain("$1.50");
    });

    it("shows warning emoji at >= 85%", () => {
      const embed = renderUsageEmbed(
        { tokensUsed: 85000, contextSize: 100000 },
        "high",
      );
      const desc = embed.data.description ?? "";
      expect(desc).toContain("⚠️");
    });
  });

  it("handles missing usage data gracefully", () => {
    const embed = renderUsageEmbed({}, "medium");
    const desc = embed.data.description ?? "";
    expect(desc).toContain("unavailable");
  });
});

// ─── renderPermissionEmbed ──────────────────────────────────────────────────

describe("renderPermissionEmbed", () => {
  const request = {
    toolName: "Bash",
    command: "rm -rf /tmp/old",
    description: "Delete temporary files",
  };

  it("uses yellow sidebar color", () => {
    const result = renderPermissionEmbed(request, "sess-1", "perm-key-1");
    expect(result.embeds[0].data.color).toBe(0xf1c40f);
  });

  it("includes tool name in embed", () => {
    const result = renderPermissionEmbed(request, "sess-1", "perm-key-1");
    const desc = result.embeds[0].data.description ?? "";
    expect(desc).toContain("Bash");
  });

  it("includes command in embed", () => {
    const result = renderPermissionEmbed(request, "sess-1", "perm-key-1");
    const desc = result.embeds[0].data.description ?? "";
    expect(desc).toContain("rm -rf /tmp/old");
  });

  it("includes description in embed", () => {
    const result = renderPermissionEmbed(request, "sess-1", "perm-key-1");
    const desc = result.embeds[0].data.description ?? "";
    expect(desc).toContain("Delete temporary files");
  });

  it("has Allow, Deny, and Always Allow buttons", () => {
    const result = renderPermissionEmbed(request, "sess-1", "perm-key-1");
    expect(result.components.length).toBe(1);
    const buttons = result.components[0].components;
    expect(buttons.length).toBe(3);

    const customIds = buttons.map((b: any) => b.data.custom_id);
    expect(customIds).toContain("p:sess-1:perm-key-1:allow");
    expect(customIds).toContain("p:sess-1:perm-key-1:deny");
    expect(customIds).toContain("p:sess-1:perm-key-1:always");
  });

  it("uses correct button styles", () => {
    const result = renderPermissionEmbed(request, "sess-1", "perm-key-1");
    const buttons = result.components[0].components;

    const allowBtn = buttons.find((b: any) => b.data.custom_id?.includes(":allow"));
    const denyBtn = buttons.find((b: any) => b.data.custom_id?.includes(":deny"));
    const alwaysBtn = buttons.find((b: any) => b.data.custom_id?.includes(":always"));

    expect((allowBtn as any).data.style).toBe(ButtonStyle.Success);
    expect((denyBtn as any).data.style).toBe(ButtonStyle.Danger);
    expect((alwaysBtn as any).data.style).toBe(ButtonStyle.Secondary);
  });
});

// ─── splitMessage ───────────────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns a single chunk when input fits in maxLength", () => {
    const text = "short message";
    expect(splitMessage(text, 100)).toEqual([text]);
  });

  it("splits at paragraph boundaries when paragraphs fit individually", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const c = "c".repeat(40);
    const text = `${a}\n\n${b}\n\n${c}`; // 40+2+40+2+40 = 124 chars
    const chunks = splitMessage(text, 90);
    // Each chunk should contain whole paragraphs joined by \n\n where possible.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Reassembling concatenates with \n\n between chunks (each chunk is one or
    // more whole paragraphs). All three source paragraphs survive.
    const reassembled = chunks.join("\n\n");
    expect(reassembled).toContain(a);
    expect(reassembled).toContain(b);
    expect(reassembled).toContain(c);
    // No chunk exceeds maxLength.
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(90);
  });

  // Regression test for a content-loss bug fixed in this PR. The previous
  // implementation handled this exact shape (a short paragraph followed by an
  // over-long paragraph) with:
  //   if (candidate.length > maxLength && current) {
  //     chunks.push(current);
  //     current = para.length > maxLength ? para.slice(0, maxLength) : para;
  //   }
  // The `slice(0, maxLength)` silently dropped everything past maxLength of
  // the long paragraph. Discovered live with buffer=2706 producing
  // chunks=[63, 1904] — 739 chars lost.
  //
  // The fix flushes `current`, then routes the over-long paragraph through
  // line-splitting (and lines through char-splitting as a last resort).
  it("preserves every character when a small paragraph precedes a long one", () => {
    const intro = "intro";
    // 6 lines × ~190 chars = ~1140 chars, one paragraph, no internal \n\n.
    const longLines = Array.from({ length: 6 }, (_, i) => `line ${i}: ${"x".repeat(180)}`);
    const longPara = longLines.join("\n");
    const text = `${intro}\n\n${longPara}`;
    expect(longPara.length).toBeGreaterThan(500);

    const chunks = splitMessage(text, 500);
    // The intro must survive.
    expect(chunks.some((c) => c.includes(intro))).toBe(true);
    // Every line of the long paragraph must survive — the old code dropped
    // chars from index 500 onward of `longPara`.
    for (const line of longLines) {
      expect(chunks.some((c) => c.includes(line))).toBe(true);
    }
    // No chunk exceeds maxLength.
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
  });

  it("hard-splits a single line that exceeds maxLength so nothing is lost", () => {
    // One line, no newlines, way over the limit.
    const text = "z".repeat(1500);
    const chunks = splitMessage(text, 500);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    // Every byte still accounted for.
    expect(chunks.join("").length).toBe(1500);
    expect(chunks.join("")).toBe(text);
  });

  it("balances unclosed code fences across chunk boundaries", () => {
    // A long fenced block that has to span multiple chunks.
    const inside = Array.from({ length: 40 }, (_, i) => `row-${i}: ${"x".repeat(40)}`).join("\n");
    const text = "```text\n" + inside + "\n```";
    const chunks = splitMessage(text, 500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk opens a fence and must close it.
    expect(chunks[0].startsWith("```text")).toBe(true);
    expect(chunks[0].trimEnd().endsWith("```")).toBe(true);
    // Subsequent chunks re-open with the same tag, and the last chunk
    // contains the original closing fence.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startsWith("```text")).toBe(true);
    }
    expect(chunks[chunks.length - 1].trimEnd().endsWith("```")).toBe(true);
    // No chunk has an unbalanced number of fence boundaries (each chunk
    // should have an even number of ``` lines after balancing).
    for (const chunk of chunks) {
      const fenceCount = (chunk.match(/^```[a-zA-Z0-9_-]*/gm) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it("handles a mix of small paragraphs and one paragraph over the limit", () => {
    const intro = "Here is some intro text.";
    const longLines = Array.from({ length: 8 }, (_, i) => `data line ${i}: ${"y".repeat(80)}`);
    const longPara = longLines.join("\n");
    const outro = "And a short outro.";
    const text = `${intro}\n\n${longPara}\n\n${outro}`;

    const chunks = splitMessage(text, 400);
    // No truncation of any kind.
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(400);
    const all = chunks.join("\n");
    expect(all).toContain(intro);
    for (const line of longLines) expect(all).toContain(line);
    expect(all).toContain(outro);
  });

  // Regression test for a code-fence balancing edge case raised in #11 review.
  // balanceCodeFences treats fences as a sequence and (in the buggy version)
  // sets pendingOpenFence to `fences[fences.length - 1]`. When a chunk has odd
  // fence count but the LAST fence is an untagged closing ``` (e.g., a fence
  // sequence of [open, close, close]), the next chunk gets an untagged ```
  // prepended instead of the original language tag.
  //
  // Trigger: input with a balanced fence followed by an extra ``` (malformed
  // by intent, but LLMs do emit this), then a separate tagged fence. The
  // middle chunk's fences = [python, close, close]; the bug propagates the
  // last close as if it were an open, stripping the language tag from the
  // next chunk's reopening.
  it("propagates the LANGUAGE TAG (not bare ```) when an extra closing fence appears in a prior chunk", () => {
    const text = [
      "This is plain text.",
      "```python\nA\n```\nB\n```", // balanced block + orphan close
      "```python\nmore code\n```",
    ].join("\n\n");
    const chunks = splitMessage(text, 30);
    // The chunk carrying "more code" must reopen with `\`\`\`python`, not
    // a bare untagged `\`\`\`` that lost the language. (The Discord render
    // for an untagged fence still works, but the bug would silently swallow
    // the language tag across all subsequent chunks.)
    const codeChunk = chunks.find((c) => c.includes("more code"));
    expect(codeChunk).toBeDefined();
    const firstLine = codeChunk!.split("\n")[0];
    expect(firstLine).toBe("```python");
  });

  // An untagged ``` fence (no language hint) wrapping a long block — split
  // across chunks must reopen with ``` on the continuation chunk so the rest
  // of the content stays inside the fenced block. Previously, untagged carry-
  // over was suppressed (to avoid the "extra closer corrupts language tag"
  // case above), which broke this legitimate scenario.
  it("re-opens an untagged ``` fence across chunk boundaries", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| col1-${i} | col2-${i} | col3-${i} |`);
    const text = "```\n" + rows.join("\n") + "\n```";
    const chunks = splitMessage(text, 500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Every continuation chunk must reopen with ``` so content stays fenced.
    for (let i = 1; i < chunks.length; i++) {
      const firstLine = chunks[i].split("\n")[0];
      expect(firstLine).toBe("```");
    }
    // No chunk should leave a row unwrapped — the second chunk shouldn't
    // start with the literal pipe content.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startsWith("|")).toBe(false);
    }
  });
});

