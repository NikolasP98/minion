import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveWeixinAccount } from "./accounts.js";
import { weixinSendMessage } from "./client.js";
import { normalizeWeixinTarget } from "./targets.js";
import type { WeixinSendResult, WeixinMessageType } from "./types.js";

export type SendWeixinMessageParams = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  accountId?: string;
  contextToken?: string;
};

/**
 * Send a text message to a Weixin user or group via the iLink Bot API.
 */
export async function sendMessageWeixin(params: SendWeixinMessageParams): Promise<WeixinSendResult> {
  const { cfg, to, text, accountId, contextToken } = params;
  const account = resolveWeixinAccount({ cfg, accountId });

  if (!account.configured || !account.botToken) {
    return { ok: false, error: `Weixin account "${account.accountId}" not configured (missing bot token)` };
  }

  const target = normalizeWeixinTarget(to);
  if (!target) {
    return { ok: false, error: `invalid target: ${to}` };
  }

  return weixinSendMessage({
    baseUrl: account.baseUrl,
    botToken: account.botToken,
    request: {
      type: 1, // WeixinMessageType.TEXT
      to_uin: target,
      text,
      context_token: contextToken,
    },
  });
}
