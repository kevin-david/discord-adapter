import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordAdapter } from "../adapter.js";
import { log } from "@openacp/plugin-sdk";

// Mock log to avoid noise
vi.mock("@openacp/plugin-sdk", async () => {
  const actual = await vi.importActual("@openacp/plugin-sdk");
  return {
    ...actual,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

// Mock discord.js
vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => ({
      rest: { on: vi.fn() },
      on: vi.fn(),
      once: vi.fn(),
      login: vi.fn().mockResolvedValue("token"),
      guilds: {
        cache: { get: vi.fn() },
        fetch: vi.fn(),
      },
    })),
  };
});

// Mock integrate command to avoid environment import issues
vi.mock("../commands/integrate.js", () => ({
  handleIntegrate: vi.fn(),
  handleIntegrateButton: vi.fn(),
}));

describe("DiscordAdapter Resume Logic", () => {
  let mockCore: any;
  let adapter: any;
  const config = {
    botToken: "test-token",
    guildId: "test-guild",
    forumChannelId: "forum-1",
    notificationChannelId: "notify-1",
    assistantThreadId: "assistant-1",
    enabled: true,
  };

  beforeEach(() => {
    mockCore = {
      configManager: { get: vi.fn().mockReturnValue({}), resolveWorkspace: vi.fn().mockReturnValue("/tmp") },
      sessionManager: {
        getSession: vi.fn(),
        getSessionByThread: vi.fn(),
        getRecordByThread: vi.fn(),
        getSessionRecord: vi.fn(),
        listSessions: vi.fn().mockReturnValue([]),
        listRecords: vi.fn().mockReturnValue([]),
        patchRecord: vi.fn().mockResolvedValue(undefined),
      },
      fileService: {},
      eventBus: { on: vi.fn(), off: vi.fn() },
      getOrResumeSession: vi.fn().mockResolvedValue({ id: "session-abc" }),
    };

    adapter = new DiscordAdapter(mockCore, config as any, undefined);
    // Manually set guild as start() would normally do it
    (adapter as any).guild = { id: config.guildId };
  });

  it("calls drainAndResetTracker (and thus onNewPrompt) on lazy resume", async () => {
    const threadId = "thread-123";
    const sessionId = "session-abc";
    
    // Simulate: No live session found for thread
    mockCore.sessionManager.getSessionByThread.mockReturnValue(undefined);
    mockCore.sessionManager.getSession.mockReturnValue(undefined);
    // But a stored record DOES exist
    mockCore.sessionManager.getRecordByThread.mockReturnValue({
      sessionId,
      status: "active",
      channelId: "discord",
    });

    // We need to access the private messageCreate handler. 
    // Since we can't easily trigger the 'messageCreate' event on the mocked client,
    // we'll mock the 'on' method and capture the callback.
    let messageHandler: any;
    (adapter.client.on as any).mockImplementation((event: string, cb: any) => {
      if (event === "messageCreate") messageHandler = cb;
    });

    // Re-run the interaction setup to capture our handler
    (adapter as any).setupMessageHandler();

    // Mock a message object
    const mockMessage = {
      author: { bot: false, id: "user-1" },
      guild: { id: "test-guild" },
      channel: { id: threadId, isThread: () => true },
      content: "ping",
      attachments: { size: 0, map: vi.fn().mockReturnValue([]) },
    };

    // Spy on the internal drainAndResetTracker
    const drainSpy = vi.spyOn(adapter as any, "drainAndResetTracker");

    // Execute the handler
    await messageHandler(mockMessage);

    // Verify:sessionId was resolved from store, and tracker was drained/reset
    expect(mockCore.sessionManager.getRecordByThread).toHaveBeenCalledWith("discord", threadId);
    expect(drainSpy).toHaveBeenCalledWith(sessionId);
    
    // Success: the tracker was reset for the new prompt, isolating replayed messages.
  });

  it("suppresses outbound messages during sync phase", async () => {
    const sessionId = "session-sync";
    
    // Manually add to syncingSessions (private set)
    (adapter as any)._syncingSessions.add(sessionId);

    // Mock a thread
    const mockThread = { id: "thread-1" } as any;
    vi.spyOn(adapter as any, "getThread").mockResolvedValue(mockThread);

    // Call sendMessage with a tool_call (should be suppressed)
    const toolCall = { type: "tool_call", text: "Read" } as any;
    await adapter.sendMessage(sessionId, toolCall);
    
    // Since it's async and enqueued, we wait a bit
    await new Promise(r => setTimeout(r, 10));

    // Verify: no message enqueued for dispatch? 
    // Actually, shouldDisplay and dispatchMessage would be skipped.
    // We can check if dispatchMessage was called.
    const dispatchSpy = vi.spyOn(adapter as any, "dispatchMessage");
    
    await adapter.sendMessage(sessionId, toolCall);
    await new Promise(r => setTimeout(r, 10));
    expect(dispatchSpy).not.toHaveBeenCalled();

    // Now send a config_update (should NOT be suppressed)
    const configUpdate = { type: "config_update", text: "Config" } as any;
    await adapter.sendMessage(sessionId, configUpdate);
    await new Promise(r => setTimeout(r, 10));
    expect(dispatchSpy).toHaveBeenCalled();
  });
});
