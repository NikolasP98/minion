import type { WeixinInboundMessage } from "./types.js";
import { WeixinMessageType } from "./types.js";

/**
 * Normalized inbound context from a Weixin message,
 * ready to be fed into the auto-reply runtime.
 */
export type WeixinNormalizedContext = {
  body: string;
  rawBody: string;
  from: string;
  to: string;
  senderName: string;
  senderId: string;
  chatType: "direct" | "group";
  chatId?: string;
  chatName?: string;
  provider: "weixin";
  surface: "weixin";
  timestamp: number;
  contextToken: string;
  mediaKey?: string;
  mediaAesKey?: string;
  mediaType?: "image" | "voice" | "file" | "video";
};

const MESSAGE_TYPE_TO_MEDIA: Record<number, "image" | "voice" | "file" | "video"> = {
  [WeixinMessageType.IMAGE]: "image",
  [WeixinMessageType.VOICE]: "voice",
  [WeixinMessageType.FILE]: "file",
  [WeixinMessageType.VIDEO]: "video",
};

/**
 * Normalize a raw iLink Bot API inbound message into a standard context object.
 */
export function normalizeWeixinMessage(
  msg: WeixinInboundMessage,
  botUin: string,
): WeixinNormalizedContext {
  const isGroup = Boolean(msg.chatId);
  const body = msg.text ?? "";

  return {
    body,
    rawBody: body,
    from: msg.fromUin,
    to: botUin,
    senderName: msg.fromNickname ?? msg.fromUin,
    senderId: msg.fromUin,
    chatType: isGroup ? "group" : "direct",
    chatId: msg.chatId,
    chatName: msg.chatName,
    provider: "weixin",
    surface: "weixin",
    timestamp: msg.timestamp,
    contextToken: msg.contextToken,
    mediaKey: msg.mediaKey,
    mediaAesKey: msg.mediaAesKey,
    mediaType: MESSAGE_TYPE_TO_MEDIA[msg.type],
  };
}

/**
 * Resolve the outbound target for replying to a normalized context.
 * For group messages, replies go to the group. For DMs, replies go to the sender.
 */
export function resolveOutboundTarget(ctx: WeixinNormalizedContext): string {
  if (ctx.chatType === "group" && ctx.chatId) {
    return `group:${ctx.chatId}`;
  }
  return `user:${ctx.from}`;
}
