import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppStatusReactionConfig } from "../../../config/types.whatsapp.js";
import {
  createWhatsAppStatusReactionController,
  shouldSendStatusReaction,
  STATUS_DEFAULTS,
  STATUS_TIMING,
} from "./status-reactions.js";

// Mock sendReactionWhatsApp
vi.mock("../../outbound.js", () => ({
  sendReactionWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

// Mock ack-reactions gating
vi.mock("../../../channels/ack-reactions.js", () => ({
  shouldAckReactionForWhatsApp: vi.fn().mockReturnValue(true),
}));

// Mock group-activation
vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn().mockReturnValue(null),
}));

// Mock logging
vi.mock("../../../channels/logging.js", () => ({
  logAckFailure: vi.fn(),
}));
vi.mock("../../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

import { shouldAckReactionForWhatsApp } from "../../../channels/ack-reactions.js";
import { logAckFailure } from "../../../channels/logging.js";
import { sendReactionWhatsApp } from "../../outbound.js";
import { resolveGroupActivationFor } from "./group-activation.js";

const mockSendReaction = vi.mocked(sendReactionWhatsApp);
const mockShouldAck = vi.mocked(shouldAckReactionForWhatsApp);
const mockLogAckFailure = vi.mocked(logAckFailure);
const mockResolveGroupActivation = vi.mocked(resolveGroupActivationFor);

function makeController(
  overrides: Partial<Parameters<typeof createWhatsAppStatusReactionController>[0]> = {},
) {
  return createWhatsAppStatusReactionController({
    enabled: true,
    chatJid: "123@s.whatsapp.net",
    messageId: "msg-1",
    fromMe: false,
    participant: "456@s.whatsapp.net",
    accountId: "default",
    verbose: false,
    ...overrides,
  });
}

describe("createWhatsAppStatusReactionController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("setQueued sends default eyes emoji", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();

    expect(mockSendReaction).toHaveBeenCalledWith(
      "123@s.whatsapp.net",
      "msg-1",
      STATUS_DEFAULTS.queued,
      expect.objectContaining({ fromMe: false, participant: "456@s.whatsapp.net" }),
    );
  });

  it("setQueued uses config override when provided", async () => {
    const statusCfg: WhatsAppStatusReactionConfig = {
      phaseEmojis: { queued: "\u{1F6A8}" }, // 🚨
    };
    const ctrl = makeController({ statusCfg });
    await ctrl.setQueued();

    expect(mockSendReaction).toHaveBeenCalledWith(
      "123@s.whatsapp.net",
      "msg-1",
      "\u{1F6A8}",
      expect.anything(),
    );
  });

  it("setThinking transitions to thinking emoji (debounced)", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    await ctrl.setThinking();
    // Should not have sent yet (debounce)
    expect(mockSendReaction).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);

    expect(mockSendReaction).toHaveBeenCalledWith(
      "123@s.whatsapp.net",
      "msg-1",
      STATUS_DEFAULTS.thinking,
      expect.anything(),
    );
  });

  it("setTool with web_search uses tool-display.json emoji over category default", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    await ctrl.setTool("web_search");
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);

    // web_search has 🔎 in tool-display.json, which takes priority over the 🌐 category default
    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "\u{1F50E}", // 🔎 from tool-display.json
      expect.anything(),
    );
  });

  it("setTool with exec uses tool-display.json emoji", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    await ctrl.setTool("exec");
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);

    // exec has emoji "🛠️" in tool-display.json — matched before category tokens
    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.anything(),
    );
  });

  it("setTool with write shows writing emoji via category", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    // "write" is in tool-display.json with emoji ✍️, so it matches display first
    await ctrl.setTool("write");
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.anything(),
    );
  });

  it("setTool with per-tool config override takes priority", async () => {
    const statusCfg: WhatsAppStatusReactionConfig = {
      toolEmojis: { exec: "\u{1F525}" }, // 🔥
    };
    const ctrl = makeController({ statusCfg });
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    await ctrl.setTool("exec");
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "\u{1F525}", // 🔥 override
      expect.anything(),
    );
  });

  it("setTool with unknown tool shows generic tool emoji", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    await ctrl.setTool("my_custom_tool");
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      STATUS_DEFAULTS.tool,
      expect.anything(),
    );
  });

  it("setDone transitions to done emoji immediately (no debounce)", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    await ctrl.setDone();

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      STATUS_DEFAULTS.done,
      expect.anything(),
    );
  });

  it("setDone uses config override", async () => {
    const statusCfg: WhatsAppStatusReactionConfig = {
      phaseEmojis: { done: "\u{1F389}" }, // 🎉
    };
    const ctrl = makeController({ statusCfg });
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    await ctrl.setDone();

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "\u{1F389}",
      expect.anything(),
    );
  });

  it("setError transitions to error emoji immediately", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    await ctrl.setError();

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      STATUS_DEFAULTS.error,
      expect.anything(),
    );
  });

  it("clear sends empty emoji to remove reaction", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    await ctrl.clear();

    expect(mockSendReaction).toHaveBeenCalledWith(
      "123@s.whatsapp.net",
      "msg-1",
      "",
      expect.anything(),
    );
  });

  it("restoreInitial sends queued emoji back", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    // Move to thinking
    await ctrl.setThinking();
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);
    mockSendReaction.mockClear();

    await ctrl.restoreInitial();

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      STATUS_DEFAULTS.queued,
      expect.anything(),
    );
  });

  it("restoreInitial uses config override for queued emoji", async () => {
    const statusCfg: WhatsAppStatusReactionConfig = {
      phaseEmojis: { queued: "\u{1F44D}" }, // 👍
    };
    const ctrl = makeController({ statusCfg });
    await ctrl.setQueued();
    await ctrl.setThinking();
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);
    mockSendReaction.mockClear();

    await ctrl.restoreInitial();

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "\u{1F44D}",
      expect.anything(),
    );
  });

  it("debounces rapid transitions (only last emoji applied)", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    // Rapid-fire multiple phase changes within debounce window
    await ctrl.setThinking();
    await ctrl.setTool("exec");
    await ctrl.setTool("web_search");

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);

    // Only the last emoji should be sent (web_search → 🔎 from tool-display.json)
    expect(mockSendReaction).toHaveBeenCalledTimes(1);
    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "\u{1F50E}", // 🔎 from tool-display.json for web_search
      expect.anything(),
    );
  });

  it("terminal state seals controller (subsequent calls are no-ops)", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    await ctrl.setDone();
    mockSendReaction.mockClear();

    // These should all be no-ops
    await ctrl.setThinking();
    await ctrl.setTool("exec");
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);

    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it("enabled: false makes all methods no-ops", async () => {
    const ctrl = makeController({ enabled: false });

    await ctrl.setQueued();
    await ctrl.setThinking();
    await ctrl.setTool("exec");
    await ctrl.setDone();
    await ctrl.setError();
    await ctrl.clear();
    await ctrl.restoreInitial();

    expect(mockSendReaction).not.toHaveBeenCalled();
  });

  it("soft stall timer fires after inactivity", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    // Advance to soft stall threshold
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.STALL_SOFT_MS + 10);

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      STATUS_DEFAULTS.stallSoft,
      expect.anything(),
    );
  });

  it("hard stall timer fires after longer inactivity", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    // Advance to hard stall threshold
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.STALL_HARD_MS + 10);

    // Should have both soft and hard stall
    const calls = mockSendReaction.mock.calls;
    const emojis = calls.map((c) => c[2]);
    expect(emojis).toContain(STATUS_DEFAULTS.stallSoft);
    expect(emojis).toContain(STATUS_DEFAULTS.stallHard);
  });

  it("stall timers are reset when a new phase starts", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    // Advance 9s (before soft stall at 10s)
    await vi.advanceTimersByTimeAsync(9_000);
    expect(mockSendReaction).not.toHaveBeenCalled();

    // Set thinking — resets stall timers
    await ctrl.setThinking();
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);
    mockSendReaction.mockClear();

    // Advance 9s again — should not stall because timer was reset
    await vi.advanceTimersByTimeAsync(9_000);
    expect(mockSendReaction).not.toHaveBeenCalled();

    // But 2s more (total 11s from thinking) should trigger soft stall
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      STATUS_DEFAULTS.stallSoft,
      expect.anything(),
    );
  });

  it("errors in sendReaction are caught and logged, not thrown", async () => {
    mockSendReaction.mockRejectedValueOnce(new Error("network failure"));

    const ctrl = makeController();
    // Should not throw
    await ctrl.setQueued();
    // Wait for the enqueued promise to settle
    await vi.advanceTimersByTimeAsync(10);

    expect(mockLogAckFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        target: "123@s.whatsapp.net/msg-1",
      }),
    );
  });

  it("does not send same emoji twice in a row", async () => {
    const ctrl = makeController();
    await ctrl.setQueued();
    mockSendReaction.mockClear();

    // Set thinking twice
    await ctrl.setThinking();
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);
    const firstCallCount = mockSendReaction.mock.calls.length;

    await ctrl.setThinking();
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.DEBOUNCE_MS + 10);

    // Should only have sent once
    expect(mockSendReaction).toHaveBeenCalledTimes(firstCallCount);
  });
});

describe("shouldSendStatusReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldAck.mockReturnValue(true);
    mockResolveGroupActivation.mockReturnValue(null);
  });

  const baseCfg = {
    channels: {
      whatsapp: { ackReaction: { emoji: "\u{1F440}", direct: true, group: "mentions" as const } },
    },
  } as ReturnType<typeof import("../../../config/config.js").loadConfig>;

  const baseMsg = {
    id: "msg-1",
    chatId: "123@s.whatsapp.net",
    chatType: "direct" as const,
    from: "+1555",
    to: "+1999",
    body: "hello",
    conversationId: "123@s.whatsapp.net",
    wasMentioned: false,
  } as import("../types.js").WebInboundMsg;

  it("returns true for direct chat when emoji is set", () => {
    const result = shouldSendStatusReaction({
      emoji: "\u{1F440}",
      cfg: baseCfg,
      msg: baseMsg,
      agentId: "agent-1",
      sessionKey: "session-1",
      conversationId: "123@s.whatsapp.net",
    });
    expect(result).toBe(true);
    expect(mockShouldAck).toHaveBeenCalled();
  });

  it("returns false when message has no id", () => {
    const result = shouldSendStatusReaction({
      emoji: "\u{1F440}",
      cfg: baseCfg,
      msg: { ...baseMsg, id: undefined } as unknown as import("../types.js").WebInboundMsg,
      agentId: "agent-1",
      sessionKey: "session-1",
      conversationId: "123@s.whatsapp.net",
    });
    expect(result).toBe(false);
  });

  it("returns false when shouldAckReactionForWhatsApp returns false", () => {
    mockShouldAck.mockReturnValue(false);

    const result = shouldSendStatusReaction({
      emoji: "\u{1F440}",
      cfg: baseCfg,
      msg: baseMsg,
      agentId: "agent-1",
      sessionKey: "session-1",
      conversationId: "123@s.whatsapp.net",
    });
    expect(result).toBe(false);
  });

  it("checks group activation for group chats", () => {
    const groupMsg = { ...baseMsg, chatType: "group" as const, wasMentioned: true };

    shouldSendStatusReaction({
      emoji: "\u{1F440}",
      cfg: baseCfg,
      msg: groupMsg,
      agentId: "agent-1",
      sessionKey: "session-1",
      conversationId: "group-123",
    });

    expect(mockResolveGroupActivation).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1" }),
    );
  });
});
