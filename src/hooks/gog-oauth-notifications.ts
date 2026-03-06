/**
 * OAuth notification system for async auth flow updates
 */

import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { createFollowupRunner } from "../auto-reply/reply/followup-runner.js";
import { scheduleFollowupDrain } from "../auto-reply/reply/queue/drain.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.ts";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import { createTypingController } from "../auto-reply/reply/typing.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveDefaultSessionStorePath } from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gog-oauth/notifications");

/**
 * Notification types
 */
export type OAuthNotificationType = "success" | "timeout" | "error";

/**
 * OAuth notification data
 */
export interface OAuthNotification {
  type: OAuthNotificationType;
  email: string;
  message: string;
  sessionKey: string;
  agentId: string;
}

/**
 * Enqueue an OAuth notification to a session
 */
async function enqueueOAuthNotification(notification: OAuthNotification): Promise<void> {
  // Load session entry to get routing information
  const storePath = resolveDefaultSessionStorePath(notification.agentId);
  const sessionStore = loadSessionStore(storePath);
  const sessionEntry = sessionStore[notification.sessionKey];

  if (!sessionEntry) {
    log.error(`Cannot send OAuth notification: session ${notification.sessionKey} not found`);
    return;
  }

  // Load config and resolve agent paths
  const config = loadConfig();
  const agentDir = resolveAgentDir(config, notification.agentId);
  const workspaceDir = resolveAgentWorkspaceDir(config, notification.agentId);

  // Resolve delivery routing — prefer lastChannel/lastTo, fall back to deliveryContext
  const originatingChannel = sessionEntry.lastChannel ?? sessionEntry.deliveryContext?.channel;
  const originatingTo = sessionEntry.lastTo ?? sessionEntry.deliveryContext?.to;
  const originatingAccountId =
    sessionEntry.lastAccountId ?? sessionEntry.deliveryContext?.accountId;
  const originatingThreadId = sessionEntry.lastThreadId ?? sessionEntry.deliveryContext?.threadId;

  if (!originatingChannel || !originatingTo) {
    log.error(
      `Cannot route OAuth notification for session ${notification.sessionKey}: no channel/to (lastChannel=${sessionEntry.lastChannel}, deliveryContext.channel=${sessionEntry.deliveryContext?.channel})`,
    );
    return;
  }

  // Build followup run from session entry
  const followupRun: FollowupRun = {
    prompt: notification.message,
    summaryLine: `OAuth ${notification.type}: ${notification.email}`,
    enqueuedAt: Date.now(),
    originatingChannel,
    originatingTo,
    originatingAccountId,
    originatingThreadId,
    originatingChatType: sessionEntry.chatType,
    run: {
      agentId: notification.agentId,
      agentDir,
      sessionId: sessionEntry.sessionId || notification.sessionKey,
      sessionKey: notification.sessionKey,
      messageProvider: originatingChannel,
      sessionFile: sessionEntry.sessionFile || "",
      workspaceDir,
      config,
      provider: sessionEntry.modelProvider || "anthropic",
      model: sessionEntry.model || "claude-sonnet-4-5-20250929",
      timeoutMs: 300000, // 5 minutes
      blockReplyBreak: "message_end",
    },
  };

  // Enqueue the notification
  const enqueued = enqueueFollowupRun(
    notification.sessionKey,
    followupRun,
    {
      mode: "followup",
      debounceMs: 0, // Send immediately
    },
    "none", // No deduplication
  );

  // Trigger drain so the notification is processed immediately
  if (enqueued) {
    const typing = createTypingController({});
    const runFollowup = createFollowupRunner({
      typing,
      typingMode: "never",
      sessionEntry,
      sessionStore,
      sessionKey: notification.sessionKey,
      storePath,
      defaultModel: sessionEntry.model || "claude-sonnet-4-5-20250929",
    });
    scheduleFollowupDrain(notification.sessionKey, runFollowup);
  }
}

/**
 * Notify user of successful OAuth authentication
 */
export async function notifyAuthSuccess(
  sessionKey: string,
  agentId: string,
  email: string,
  services: string[],
  keyringSyncError?: string,
): Promise<void> {
  const servicesStr = services.length > 0 ? services.join(", ") : "Gmail";
  let message = `✓ Google authentication complete for ${email}! You can now use ${servicesStr} features.`;

  if (keyringSyncError) {
    message += `\n⚠ Warning: keyring sync failed (${keyringSyncError}). gog_exec will retry sync automatically on each command.`;
  }

  await enqueueOAuthNotification({
    type: "success",
    email,
    sessionKey,
    agentId,
    message,
  });
}

/**
 * Notify user of OAuth authentication timeout
 */
export async function notifyAuthTimeout(
  sessionKey: string,
  agentId: string,
  email: string,
): Promise<void> {
  await enqueueOAuthNotification({
    type: "timeout",
    email,
    sessionKey,
    agentId,
    message: `⏱ Google authorization for ${email} timed out (5 minutes). Would you like to try again?`,
  });
}

/**
 * Notify user of OAuth authentication error
 */
export async function notifyAuthError(
  sessionKey: string,
  agentId: string,
  email: string,
  error: string,
): Promise<void> {
  let message: string;

  if (error === "access_denied") {
    message = `✗ Google authorization for ${email} was declined. Let me know if you'd like to try again.`;
  } else {
    message = `✗ Google authorization for ${email} failed: ${error}. Please try again.`;
  }

  await enqueueOAuthNotification({
    type: "error",
    email,
    sessionKey,
    agentId,
    message,
  });
}
