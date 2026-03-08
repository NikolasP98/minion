import { shouldAckReactionForWhatsApp } from "../../../channels/ack-reactions.js";
import { logAckFailure } from "../../../channels/logging.js";
import type { loadConfig } from "../../../config/config.js";
import { logVerbose } from "../../../globals.js";
import { sendReactionWhatsApp } from "../../outbound.js";
import type { WebInboundMsg } from "../types.js";
import { resolveGroupActivationFor } from "./group-activation.js";

// ============================================================================
// Emoji constants — same vocabulary as Discord status reactions
// ============================================================================

const WA_STATUS_THINKING = "\u{1F9E0}"; // 🧠
const WA_STATUS_TOOL = "\u{1F6E0}\u{FE0F}"; // 🛠️
const WA_STATUS_CODING = "\u{1F4BB}"; // 💻
const WA_STATUS_WEB = "\u{1F310}"; // 🌐
const WA_STATUS_DONE = "\u{2705}"; // ✅
const WA_STATUS_ERROR = "\u{274C}"; // ❌
const WA_STATUS_STALL_SOFT = "\u{23F3}"; // ⏳
const WA_STATUS_STALL_HARD = "\u{26A0}\u{FE0F}"; // ⚠️

const DEBOUNCE_MS = 700;
const STALL_SOFT_MS = 10_000;
const STALL_HARD_MS = 30_000;
const DONE_HOLD_MS = 1500;
const ERROR_HOLD_MS = 2500;

// ============================================================================
// Tool → emoji resolution
// ============================================================================

const CODING_TOOL_TOKENS = ["exec", "process", "read", "write", "edit", "session_status", "bash"];
const WEB_TOOL_TOKENS = ["web_search", "web-search", "web_fetch", "web-fetch", "browser"];

function resolveToolStatusEmoji(toolName?: string): string {
  const normalized = toolName?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return WA_STATUS_TOOL;
  }
  if (WEB_TOOL_TOKENS.some((token) => normalized.includes(token))) {
    return WA_STATUS_WEB;
  }
  if (CODING_TOOL_TOKENS.some((token) => normalized.includes(token))) {
    return WA_STATUS_CODING;
  }
  return WA_STATUS_TOOL;
}

// ============================================================================
// Gating — determines if status reactions should be shown
// ============================================================================

export function shouldSendStatusReaction(params: {
  emoji: string;
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  accountId?: string;
}): boolean {
  if (!params.msg.id) {
    return false;
  }

  const ackConfig = params.cfg.channels?.whatsapp?.ackReaction;
  const emoji = params.emoji.trim() || (ackConfig?.emoji ?? "").trim();
  const directEnabled = ackConfig?.direct ?? true;
  const groupMode = ackConfig?.group ?? "mentions";
  const conversationIdForCheck = params.msg.conversationId ?? params.msg.from;

  const activation =
    params.msg.chatType === "group"
      ? resolveGroupActivationFor({
          cfg: params.cfg,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          conversationId: conversationIdForCheck,
        })
      : null;

  return shouldAckReactionForWhatsApp({
    emoji,
    isDirect: params.msg.chatType === "direct",
    isGroup: params.msg.chatType === "group",
    directEnabled,
    groupMode,
    wasMentioned: params.msg.wasMentioned === true,
    groupActivated: activation === "always",
  });
}

// ============================================================================
// Status reaction controller
// ============================================================================

export type WhatsAppStatusReactionController = {
  setQueued: () => Promise<void>;
  setThinking: () => Promise<void>;
  setTool: (toolName?: string) => Promise<void>;
  setDone: () => Promise<void>;
  setError: () => Promise<void>;
  clear: () => Promise<void>;
  restoreInitial: () => Promise<void>;
};

export function createWhatsAppStatusReactionController(params: {
  enabled: boolean;
  chatJid: string;
  messageId: string;
  initialEmoji: string;
  fromMe: boolean;
  participant?: string;
  accountId?: string;
  verbose: boolean;
}): WhatsAppStatusReactionController {
  let activeEmoji: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let pendingEmoji: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let softStallTimer: ReturnType<typeof setTimeout> | null = null;
  let hardStallTimer: ReturnType<typeof setTimeout> | null = null;

  const logTarget = `${params.chatJid}/${params.messageId}`;

  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch((err) => {
      logAckFailure({ log: logVerbose, channel: "whatsapp", target: logTarget, error: err });
    });
    return chain;
  };

  const sendEmoji = async (emoji: string) => {
    await sendReactionWhatsApp(params.chatJid, params.messageId, emoji, {
      verbose: params.verbose,
      fromMe: params.fromMe,
      participant: params.participant,
      accountId: params.accountId,
    });
  };

  const clearStallTimers = () => {
    if (softStallTimer) {
      clearTimeout(softStallTimer);
      softStallTimer = null;
    }
    if (hardStallTimer) {
      clearTimeout(hardStallTimer);
      hardStallTimer = null;
    }
  };

  const clearPendingDebounce = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingEmoji = null;
  };

  const applyEmoji = (emoji: string) =>
    enqueue(async () => {
      if (!params.enabled || !emoji || activeEmoji === emoji) {
        return;
      }
      // WhatsApp: sending a new reaction automatically replaces the previous one.
      // No need to remove the old emoji first (unlike Discord).
      await sendEmoji(emoji);
      activeEmoji = emoji;
    });

  const requestEmoji = (emoji: string, options?: { immediate?: boolean }) => {
    if (!params.enabled || !emoji) {
      return Promise.resolve();
    }
    if (options?.immediate) {
      clearPendingDebounce();
      return applyEmoji(emoji);
    }
    pendingEmoji = emoji;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const emojiToApply = pendingEmoji;
      pendingEmoji = null;
      if (!emojiToApply || emojiToApply === activeEmoji) {
        return;
      }
      void applyEmoji(emojiToApply);
    }, DEBOUNCE_MS);
    return Promise.resolve();
  };

  const scheduleStallTimers = () => {
    if (!params.enabled || finished) {
      return;
    }
    clearStallTimers();
    softStallTimer = setTimeout(() => {
      if (finished) {
        return;
      }
      void requestEmoji(WA_STATUS_STALL_SOFT, { immediate: true });
    }, STALL_SOFT_MS);
    hardStallTimer = setTimeout(() => {
      if (finished) {
        return;
      }
      void requestEmoji(WA_STATUS_STALL_HARD, { immediate: true });
    }, STALL_HARD_MS);
  };

  const setPhase = (emoji: string) => {
    if (!params.enabled || finished) {
      return Promise.resolve();
    }
    scheduleStallTimers();
    return requestEmoji(emoji);
  };

  const setTerminal = async (emoji: string) => {
    if (!params.enabled) {
      return;
    }
    finished = true;
    clearStallTimers();
    await requestEmoji(emoji, { immediate: true });
  };

  const noop = () => Promise.resolve();

  if (!params.enabled) {
    return {
      setQueued: noop,
      setThinking: noop,
      setTool: noop,
      setDone: noop,
      setError: noop,
      clear: noop,
      restoreInitial: noop,
    };
  }

  return {
    setQueued: () => {
      scheduleStallTimers();
      return requestEmoji(params.initialEmoji, { immediate: true });
    },
    setThinking: () => setPhase(WA_STATUS_THINKING),
    setTool: (toolName?: string) => setPhase(resolveToolStatusEmoji(toolName)),
    setDone: () => setTerminal(WA_STATUS_DONE),
    setError: () => setTerminal(WA_STATUS_ERROR),
    clear: async () => {
      if (!params.enabled) {
        return;
      }
      finished = true;
      clearStallTimers();
      clearPendingDebounce();
      // WhatsApp: empty emoji string removes the reaction
      await enqueue(async () => {
        await sendEmoji("");
        activeEmoji = null;
      });
    },
    restoreInitial: async () => {
      if (!params.enabled) {
        return;
      }
      finished = true;
      clearStallTimers();
      clearPendingDebounce();
      await requestEmoji(params.initialEmoji, { immediate: true });
    },
  };
}

// Re-export timing constants for testing
export const STATUS_TIMING = {
  DEBOUNCE_MS,
  STALL_SOFT_MS,
  STALL_HARD_MS,
  DONE_HOLD_MS,
  ERROR_HOLD_MS,
} as const;
