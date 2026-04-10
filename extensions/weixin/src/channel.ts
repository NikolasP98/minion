import type { ChannelMeta, ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk";
import {
  buildBaseChannelStatusSummary,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
} from "openclaw/plugin-sdk";
import {
  resolveWeixinAccount,
  listWeixinAccountIds,
  resolveDefaultWeixinAccountId,
} from "./accounts.js";
import { weixinOutbound } from "./outbound.js";
import { probeWeixin } from "./probe.js";
import { sendMessageWeixin } from "./send.js";
import { normalizeWeixinTarget, looksLikeWeixinId } from "./targets.js";
import type { WeixinConfig, ResolvedWeixinAccount, WeixinAccountConfig } from "./types.js";

const meta: ChannelMeta = {
  id: "weixin",
  label: "Weixin",
  selectionLabel: "Weixin/WeChat (微信)",
  docsPath: "/channels/weixin",
  docsLabel: "weixin",
  blurb: "Personal WeChat messaging via iLink Bot API.",
  aliases: ["wechat"],
  order: 75,
};

export const weixinPlugin: ChannelPlugin<ResolvedWeixinAccount> = {
  id: "weixin",
  meta: { ...meta },
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: false,
    threads: false,
    media: false, // Phase 1: media requires AES-128-ECB CDN upload — not yet supported
    reactions: false,
    edit: false,
    reply: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Weixin targeting: omit `target` to reply to the current conversation. Explicit targets: `user:<uin>` or `group:<chatId>`.",
      "- Weixin supports text messages only in Phase 1. Media support (images, voice, video) requires AES-128-ECB encryption and will be added later.",
    ],
  },
  reload: { configPrefixes: ["channels.weixin"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        botToken: { type: "string" },
        tokenFile: { type: "string" },
        baseUrl: { type: "string", format: "uri", pattern: "^https://" },
        pollTimeoutSec: { type: "integer", minimum: 5, maximum: 60 },
        dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
        allowFrom: { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } },
        groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
        groupAllowFrom: {
          type: "array",
          items: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
        requireMention: { type: "boolean" },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              name: { type: "string" },
              botToken: { type: "string" },
              tokenFile: { type: "string" },
              baseUrl: { type: "string", format: "uri" },
            },
          },
        },
      },
    },
  },
  config: {
    listAccountIds: (cfg) => listWeixinAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWeixinAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWeixinAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            weixin: {
              ...cfg.channels?.weixin,
              enabled,
            },
          },
        };
      }

      const weixinCfg = cfg.channels?.weixin as WeixinConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          weixin: {
            ...weixinCfg,
            accounts: {
              ...weixinCfg?.accounts,
              [accountId]: {
                ...weixinCfg?.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        const next = { ...cfg } as ClawdbotConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>).weixin;
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      const weixinCfg = cfg.channels?.weixin as WeixinConfig | undefined;
      const accounts = { ...weixinCfg?.accounts };
      delete accounts[accountId];

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          weixin: {
            ...weixinCfg,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveWeixinAccount({ cfg, accountId });
      return (account.config?.allowFrom ?? []).map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean),
  },
  security: {
    collectWarnings: ({ cfg, accountId }) => {
      const account = resolveWeixinAccount({ cfg, accountId });
      const weixinCfg = account.config;
      const defaultGroupPolicy = (
        cfg.channels as Record<string, { groupPolicy?: string }> | undefined
      )?.defaults?.groupPolicy;
      const groupPolicy = weixinCfg?.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- Weixin[${account.accountId}] groups: groupPolicy="open" allows any group member to trigger the bot. Set channels.weixin.groupPolicy="allowlist" + channels.weixin.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg, accountId }) => {
      const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            weixin: {
              ...cfg.channels?.weixin,
              enabled: true,
            },
          },
        };
      }

      const weixinCfg = cfg.channels?.weixin as WeixinConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          weixin: {
            ...weixinCfg,
            accounts: {
              ...weixinCfg?.accounts,
              [accountId]: {
                ...weixinCfg?.accounts?.[accountId],
                enabled: true,
              },
            },
          },
        },
      };
    },
  },
  messaging: {
    normalizeTarget: (raw) => normalizeWeixinTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLikeWeixinId,
      hint: "<uin|user:uin|group:chatId>",
    },
  },
  outbound: weixinOutbound,
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => await probeWeixin(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorWeixinProvider } = await import("./monitor.js");
      ctx.log?.info(`starting weixin[${ctx.accountId}]`);
      return monitorWeixinProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
      });
    },
    loginWithQrStart: async () => {
      const { weixinGetLoginQrCode } = await import("./client.js");
      const result = await weixinGetLoginQrCode({
        baseUrl: "https://ilinkai.weixin.qq.com",
      });
      if (result.error) {
        return { message: `QR login failed: ${result.error}` };
      }
      return {
        qrDataUrl: result.qrcode ? `data:image/png;base64,${result.qrcode}` : undefined,
        message: "Scan the QR code with your WeChat app to log in.",
      };
    },
    loginWithQrWait: async (params) => {
      // This would need the QR code identifier from loginWithQrStart
      // Simplified: return not-yet-connected status
      return {
        connected: false,
        message: "QR login confirmation polling not yet implemented in Phase 1.",
      };
    },
  },
};
