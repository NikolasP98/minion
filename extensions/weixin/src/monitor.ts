import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveWeixinAccount } from "./accounts.js";
import { weixinGetUpdates } from "./client.js";
import { normalizeWeixinMessage, resolveOutboundTarget } from "./normalize.js";
import { probeWeixin } from "./probe.js";
import type { WeixinInboundMessage } from "./types.js";

export type MonitorWeixinOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  /** Callback invoked for each normalized inbound message */
  onMessage?: (ctx: ReturnType<typeof normalizeWeixinMessage>, replyTo: string) => Promise<void>;
};

/**
 * Long-poll monitor for the Weixin iLink Bot API.
 * Continuously polls /ilink/bot/getupdates and dispatches
 * normalized messages to the onMessage callback.
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const { config, runtime, abortSignal, accountId } = opts;
  if (!config) {
    throw new Error("monitorWeixinProvider requires config");
  }

  const account = resolveWeixinAccount({ cfg: config, accountId });
  if (!account.configured || !account.botToken) {
    throw new Error(`Weixin account "${account.accountId}" not configured`);
  }

  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Probe to get bot identity
  const probeResult = await probeWeixin(account);
  const botUin = probeResult.botUin ?? "unknown";

  if (probeResult.ok) {
    log(`[weixin] bot connected: ${probeResult.botNickname ?? botUin}`);
  } else {
    error(`[weixin] probe failed: ${probeResult.error} — continuing with polling`);
  }

  let cursor: string | undefined;

  while (!abortSignal?.aborted) {
    try {
      const response = await weixinGetUpdates({
        baseUrl: account.baseUrl,
        botToken: account.botToken,
        cursor,
        pollTimeoutSec: account.pollTimeoutSec,
      });

      // Update cursor for next poll
      if (response.get_updates_buf) {
        cursor = response.get_updates_buf;
      }

      // Process updates
      if (response.updates?.length) {
        for (const msg of response.updates) {
          if (abortSignal?.aborted) break;

          try {
            const normalized = normalizeWeixinMessage(msg, botUin);
            const replyTo = resolveOutboundTarget(normalized);

            if (opts.onMessage) {
              await opts.onMessage(normalized, replyTo);
            }
          } catch (msgErr) {
            error(`[weixin] error processing message: ${msgErr instanceof Error ? msgErr.message : String(msgErr)}`);
          }
        }
      }

      // Handle API errors
      if (response.errcode && response.errcode !== 0) {
        error(`[weixin] getupdates error: ${response.errmsg ?? `code ${response.errcode}`}`);
        // Back off on errors
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    } catch (pollErr) {
      if (abortSignal?.aborted) break;
      error(`[weixin] poll error: ${pollErr instanceof Error ? pollErr.message : String(pollErr)}`);
      // Back off on network errors
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }

  log("[weixin] monitor stopped");
}
