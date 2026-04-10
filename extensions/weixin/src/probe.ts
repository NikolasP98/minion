import { weixinCheck } from "./client.js";
import type { ResolvedWeixinAccount, WeixinProbeResult } from "./types.js";

/**
 * Health-check probe for a Weixin account.
 * Verifies the bot token is valid and the API is reachable.
 */
export async function probeWeixin(account: ResolvedWeixinAccount): Promise<WeixinProbeResult> {
  if (!account.botToken) {
    return {
      ok: false,
      error: "missing bot token — run QR login first",
    };
  }

  const start = Date.now();

  const result = await weixinCheck({
    baseUrl: account.baseUrl,
    botToken: account.botToken,
    timeoutMs: 10_000,
  });

  const elapsedMs = Date.now() - start;

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      elapsedMs,
    };
  }

  return {
    ok: true,
    botUin: result.botUin,
    botNickname: result.botNickname,
    status: "connected",
    elapsedMs,
  };
}
