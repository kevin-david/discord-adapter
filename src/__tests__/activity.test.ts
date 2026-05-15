import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Message, TextChannel } from "discord.js";
import { ActivityTracker } from "../activity.js";
import type { ToolCallMeta, OutputMode } from "../activity.js";

// ─── Mock helpers ────────────────────────────────────────────────────────────

function mockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    edit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Message;
}

function mockChannel(): TextChannel {
  const sentMsg = mockMessage();
  return {
    send: vi.fn().mockResolvedValue(sentMsg),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  } as unknown as TextChannel;
}

function mockSendQueue() {
  return {
    enqueue: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
  };
}

function makeMeta(overrides: Partial<ToolCallMeta> = {}): ToolCallMeta {
  return {
    id: "tool-1",
    name: "Read",
    kind: "read",
    status: "running",
    ...overrides,
  };
}

function createTracker(opts: {
  channel?: TextChannel;
  sendQueue?: ReturnType<typeof mockSendQueue>;
  outputMode?: OutputMode;
  sessionId?: string;
} = {}) {
  const channel = opts.channel ?? mockChannel();
  const sendQueue = opts.sendQueue ?? mockSendQueue();
  const tracker = new ActivityTracker(
    channel,
    sendQueue as any,
    opts.outputMode ?? "medium",
    opts.sessionId ?? "sess-1",
  );
  return { tracker, channel, sendQueue };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ActivityTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("onThought", () => {
    it("shows typing indicator on the channel", async () => {
      const { tracker, channel } = createTracker();

      await tracker.onThought("thinking about something...");

      expect(channel.sendTyping).toHaveBeenCalled();

      await tracker.cleanup();
    });

    it("refreshes typing indicator every 8 seconds", async () => {
      const { tracker, channel } = createTracker();

      await tracker.onThought("think");
      expect(channel.sendTyping).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(channel.sendTyping).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(channel.sendTyping).toHaveBeenCalledTimes(3);

      await tracker.cleanup();
    });

    it("handles rapid concurrent onThought calls without spawning multiple timers", async () => {
      const { tracker, channel } = createTracker();

      // Mock sendTyping to be slightly slow (awaits a microtask)
      (channel.sendTyping as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await Promise.resolve();
      });

      // Fire multiple synchronous calls
      await Promise.all([
        tracker.onThought("a"),
        tracker.onThought("b"),
        tracker.onThought("c"),
      ]);

      // Before the fix, this would have triggered 3 sendTyping calls and 3 intervals
      expect(channel.sendTyping).toHaveBeenCalledTimes(1);

      // Fast forward and check that only ONE refresh happened
      await vi.advanceTimersByTimeAsync(8_000);
      expect(channel.sendTyping).toHaveBeenCalledTimes(2);

      await tracker.cleanup();
    });
  });

  describe("onToolCall", () => {
    it("stops typing and sends a tool card embed via channel.send", async () => {
      const { tracker, channel } = createTracker();

      await tracker.onThought("thinking...");
      expect(channel.sendTyping).toHaveBeenCalled();
      (channel.send as ReturnType<typeof vi.fn>).mockClear();

      await tracker.onToolCall(makeMeta(), "read", { file_path: "main.ts" });

      // ToolCardState fires first flush synchronously on first spec
      expect(channel.send).toHaveBeenCalledTimes(1);
      const sendCall = (channel.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.embeds).toBeDefined();
      expect(sendCall.embeds.length).toBeGreaterThan(0);

      // Typing should no longer refresh
      const typingCountBefore = (channel.sendTyping as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(8_000);
      expect((channel.sendTyping as ReturnType<typeof vi.fn>).mock.calls.length).toBe(typingCountBefore);

      await tracker.cleanup();
    });

    it("sends tool card with sendQueue.enqueue", async () => {
      const { tracker, sendQueue } = createTracker();

      await tracker.onToolCall(makeMeta(), "read", { file_path: "main.ts" });

      // At least one enqueue call for the tool card send
      expect(sendQueue.enqueue).toHaveBeenCalled();

      await tracker.cleanup();
    });
  });

  describe("onToolUpdate", () => {
    it("edits existing tool card message when updating a known tool", async () => {
      const sentMsg = mockMessage();
      const channel = {
        send: vi.fn().mockResolvedValue(sentMsg),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      } as unknown as TextChannel;
      const sendQueue = mockSendQueue();

      const tracker = new ActivityTracker(channel, sendQueue as any, "medium", "sess-1");

      // Send initial tool call
      await tracker.onToolCall(makeMeta({ id: "t1" }), "read", { file_path: "foo.ts" });
      expect(channel.send).toHaveBeenCalledTimes(1);

      // Update the tool status — triggers debounced flush
      await tracker.onToolUpdate("t1", "completed");

      // Advance past debounce timer (500ms in ToolCardState)
      await vi.advanceTimersByTimeAsync(600);

      // Should have edited the existing message
      expect(sentMsg.edit).toHaveBeenCalled();

      await tracker.cleanup();
    });
  });

  describe("onTextStart", () => {
    it("seals tool card so new tools go to a new card", async () => {
      const sentMsg1 = mockMessage({ id: "msg-1" } as any);
      const sentMsg2 = mockMessage({ id: "msg-2" } as any);
      const channel = {
        send: vi.fn()
          .mockResolvedValueOnce(sentMsg1)
          .mockResolvedValueOnce(sentMsg2),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      } as unknown as TextChannel;
      const sendQueue = mockSendQueue();

      const tracker = new ActivityTracker(channel, sendQueue as any, "medium", "sess-1");

      // First tool call → creates first card
      await tracker.onToolCall(makeMeta({ id: "t1" }), "read", { file_path: "a.ts" });
      expect(channel.send).toHaveBeenCalledTimes(1);

      // Text starts → seals the card
      await tracker.onTextStart();

      // Second tool call → should create a new card (new message)
      await tracker.onToolCall(makeMeta({ id: "t2" }), "edit", { file_path: "b.ts" });
      expect(channel.send).toHaveBeenCalledTimes(2);

      await tracker.cleanup();
    });

    it("stops typing indicator", async () => {
      const { tracker, channel } = createTracker();

      await tracker.onThought("hmm...");
      expect(channel.sendTyping).toHaveBeenCalledTimes(1);

      await tracker.onTextStart();

      // Typing refresh should be stopped
      const countAfter = (channel.sendTyping as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(16_000);
      expect((channel.sendTyping as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countAfter);

      await tracker.cleanup();
    });
  });

  describe("onNewPrompt", () => {
    it("swaps current to previous — late updates go to previous card", async () => {
      const sentMsg1 = mockMessage({ id: "msg-1" } as any);
      const sentMsg2 = mockMessage({ id: "msg-2" } as any);
      const channel = {
        send: vi.fn()
          .mockResolvedValueOnce(sentMsg1)
          .mockResolvedValueOnce(sentMsg2),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      } as unknown as TextChannel;
      const sendQueue = mockSendQueue();

      const tracker = new ActivityTracker(channel, sendQueue as any, "medium", "sess-1");

      // First prompt: tool call
      await tracker.onToolCall(makeMeta({ id: "t1" }), "read", { file_path: "a.ts" });
      expect(channel.send).toHaveBeenCalledTimes(1);

      // New prompt — finalizes current, swaps to previous
      await tracker.onNewPrompt();
      // Advance debounce timers from finalize
      await vi.advanceTimersByTimeAsync(600);

      // Late update for t1 should route to previous card (sentMsg1)
      await tracker.onToolUpdate("t1", "completed");
      await vi.advanceTimersByTimeAsync(600);

      // The previous card message should have been edited
      expect(sentMsg1.edit).toHaveBeenCalled();

      await tracker.cleanup();
    });
  });

  describe("cleanup", () => {
    it("finalizes all pending state without errors", async () => {
      const { tracker, channel } = createTracker();

      await tracker.onThought("thinking...");
      await tracker.onToolCall(makeMeta(), "read", { file_path: "main.ts" });

      // Should not throw
      await tracker.cleanup();

      // Typing should be stopped
      const typingCount = (channel.sendTyping as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(16_000);
      expect((channel.sendTyping as ReturnType<typeof vi.fn>).mock.calls.length).toBe(typingCount);
    });

    it("is safe to call multiple times", async () => {
      const { tracker } = createTracker();

      await tracker.cleanup();
      await tracker.cleanup();
      // No error
    });
  });

  describe("destroy", () => {
    it("cleans up without finalizing — no extra sends", async () => {
      const { tracker, channel } = createTracker();

      await tracker.onToolCall(makeMeta(), "read", { file_path: "x.ts" });
      const sendCount = (channel.send as ReturnType<typeof vi.fn>).mock.calls.length;

      tracker.destroy();

      // No additional sends after destroy
      await vi.advanceTimersByTimeAsync(1000);
      expect((channel.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCount);
    });
  });

  describe("out-of-order updates", () => {
    it("routes update for unknown ID to previous tool state map", async () => {
      const sentMsg1 = mockMessage({ id: "msg-1" } as any);
      const sentMsg2 = mockMessage({ id: "msg-2" } as any);
      const channel = {
        send: vi.fn()
          .mockResolvedValueOnce(sentMsg1)
          .mockResolvedValueOnce(sentMsg2),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      } as unknown as TextChannel;
      const sendQueue = mockSendQueue();

      const tracker = new ActivityTracker(channel, sendQueue as any, "medium", "sess-1");

      // First tool on first card
      await tracker.onToolCall(makeMeta({ id: "t1" }), "read", { file_path: "a.ts" });

      // Seal the card (via onTextStart or onThought after content)
      await tracker.onTextStart();

      // Second tool on second card
      await tracker.onToolCall(makeMeta({ id: "t2" }), "edit", { file_path: "b.ts" });

      // Out-of-order update for t1 (first card)
      await tracker.onToolUpdate("t1", "completed");
      await vi.advanceTimersByTimeAsync(600);

      // Should have edited the first card message
      expect(sentMsg1.edit).toHaveBeenCalled();

      await tracker.cleanup();
    });
  });

  describe("onPlan", () => {
    it("updates tool card with plan entries alongside tool calls", async () => {
      const { tracker, channel } = createTracker();

      // Tool call first — creates the tool card
      await tracker.onToolCall(makeMeta({ id: "t1" }), "read", { file_path: "a.ts" });
      expect(channel.send).toHaveBeenCalledTimes(1);

      // Plan entries update the same card (debounced)
      await tracker.onPlan([
        { content: "Read files", status: "completed", priority: "high" },
        { content: "Edit code", status: "in_progress", priority: "high" },
      ]);

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(600);

      // The tool card message should have been edited with plan info
      const sentMsg = await (channel.send as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(sentMsg.edit).toHaveBeenCalled();

      await tracker.cleanup();
    });
  });

  describe("setOutputMode", () => {
    it("changes the output mode for subsequent renders", async () => {
      const { tracker } = createTracker({ outputMode: "low" });

      tracker.setOutputMode("high");

      // No error — mode is stored for next render
      await tracker.cleanup();
    });
  });
});
