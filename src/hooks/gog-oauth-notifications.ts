/**
 * OAuth notification system for async auth flow updates.
 *
 * Sends notifications directly via routeReply (no LLM round-trip).
 */

import { routeReply } from "../auto-reply/reply/route-reply.js";
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
 * Send an OAuth notification directly to the originating channel.
 */
async function sendOAuthNotification(notification: OAuthNotification): Promise<void> {
  log.info(
    `Sending OAuth ${notification.type} notification for ${notification.email} (session=${notification.sessionKey})`,
  );

  // Load session entry to get routing information
  const storePath = resolveDefaultSessionStorePath(notification.agentId);
  const sessionStore = loadSessionStore(storePath);
  const sessionEntry = sessionStore[notification.sessionKey];

  if (!sessionEntry) {
    log.error(`Cannot send OAuth notification: session ${notification.sessionKey} not found`);
    return;
  }

  // Resolve delivery routing — prefer lastChannel/lastTo, fall back to deliveryContext
  const channel = sessionEntry.lastChannel ?? sessionEntry.deliveryContext?.channel;
  const to = sessionEntry.lastTo ?? sessionEntry.deliveryContext?.to;
  const accountId = sessionEntry.lastAccountId ?? sessionEntry.deliveryContext?.accountId;
  const threadId = sessionEntry.lastThreadId ?? sessionEntry.deliveryContext?.threadId;

  if (!channel || !to) {
    log.error(
      `Cannot route OAuth notification for session ${notification.sessionKey}: no channel/to (lastChannel=${sessionEntry.lastChannel}, deliveryContext.channel=${sessionEntry.deliveryContext?.channel})`,
    );
    return;
  }

  log.info(`Routing OAuth notification to ${channel}:${to}`);

  const cfg = loadConfig();
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await routeReply({
      payload: { text: notification.message },
      channel,
      to,
      sessionKey: notification.sessionKey,
      accountId,
      threadId,
      cfg,
    });

    if (result.ok) {
      log.info(`OAuth notification delivered to ${channel}:${to}`);
      return;
    }

    log.warn(
      `OAuth notification attempt ${attempt}/${maxAttempts} failed: ${result.error ?? "unknown error"}`,
    );

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    }
  }

  log.error(`OAuth notification delivery failed after ${maxAttempts} attempts`);
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

  await sendOAuthNotification({
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
  await sendOAuthNotification({
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

  await sendOAuthNotification({
    type: "error",
    email,
    sessionKey,
    agentId,
    message,
  });
}
