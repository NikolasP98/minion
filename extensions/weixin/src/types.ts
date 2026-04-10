import type { BaseProbeResult } from "openclaw/plugin-sdk";

/** iLink Bot API configuration stored in channels.weixin */
export type WeixinConfig = {
  enabled?: boolean;
  /** Bot token obtained from QR login flow */
  botToken?: string;
  /** File path for persisted token (default: .weixin-token.json) */
  tokenFile?: string;
  /** iLink API base URL (default: https://ilinkai.weixin.qq.com) */
  baseUrl?: string;
  /** Long-poll timeout in seconds (default: 35) */
  pollTimeoutSec?: number;
  /** DM access control policy */
  dmPolicy?: "open" | "pairing" | "allowlist";
  /** Sender allowlist (WeChat UIN or alias) */
  allowFrom?: Array<string | number>;
  /** Group access control policy */
  groupPolicy?: "open" | "allowlist" | "disabled";
  /** Group allowlist */
  groupAllowFrom?: Array<string | number>;
  /** Whether the bot must be @mentioned in groups */
  requireMention?: boolean;
  /** Per-account overrides */
  accounts?: Record<string, WeixinAccountConfig>;
};

export type WeixinAccountConfig = {
  enabled?: boolean;
  name?: string;
  botToken?: string;
  tokenFile?: string;
  baseUrl?: string;
};

export type ResolvedWeixinAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  botToken?: string;
  baseUrl: string;
  pollTimeoutSec: number;
  config: WeixinConfig;
};

/** Inbound message from iLink Bot API getupdates */
export type WeixinInboundMessage = {
  /** Message type: 1=text, 2=image, 3=voice, 4=file, 5=video */
  type: number;
  /** Sender UIN (unique identifier) */
  fromUin: string;
  /** Sender display name */
  fromNickname?: string;
  /** Chat/group ID (empty for DMs) */
  chatId?: string;
  /** Chat display name */
  chatName?: string;
  /** Message text content (type=1) */
  text?: string;
  /** CDN media key (type=2,3,4,5) */
  mediaKey?: string;
  /** AES key for media decryption */
  mediaAesKey?: string;
  /** Context token for threaded replies */
  contextToken: string;
  /** Raw message timestamp */
  timestamp: number;
};

export type WeixinSendResult = {
  ok: boolean;
  error?: string;
};

export type WeixinProbeResult = BaseProbeResult<string> & {
  botUin?: string;
  botNickname?: string;
  status?: string;
  elapsedMs?: number;
};

/** iLink getupdates response shape */
export type WeixinGetUpdatesResponse = {
  errcode?: number;
  errmsg?: string;
  updates?: WeixinInboundMessage[];
  get_updates_buf?: string;
};

/** iLink send message request body */
export type WeixinSendRequest = {
  type: number;
  to_uin: string;
  text?: string;
  media_key?: string;
  context_token?: string;
};

/** Message type constants */
export const WeixinMessageType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;
