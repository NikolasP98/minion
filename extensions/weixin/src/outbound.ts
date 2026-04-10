import type { ChannelOutboundAdapter } from "minion/plugin-sdk";
import { sendMessageWeixin } from "./send.js";

export const weixinOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    const result = await sendMessageWeixin({
      cfg,
      to,
      text,
      accountId: accountId ?? undefined,
    });
    if (!result.ok) {
      throw new Error(`weixin sendText failed: ${result.error}`);
    }
    return { channel: "weixin" };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    // Phase 1: media sending is not supported yet (requires AES-128-ECB encryption for CDN upload).
    // Fall back to sending the URL as text.
    const fallbackText = text?.trim()
      ? `${text}\n\n${mediaUrl ?? ""}`
      : mediaUrl ?? "";

    const result = await sendMessageWeixin({
      cfg,
      to,
      text: fallbackText.trim(),
      accountId: accountId ?? undefined,
    });
    if (!result.ok) {
      throw new Error(`weixin sendMedia failed: ${result.error}`);
    }
    return { channel: "weixin" };
  },
};
