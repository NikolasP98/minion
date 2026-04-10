import type { App } from "@slack/bolt";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../../config/config.js";
import type { RuntimeEnv } from "../../../../runtime.js";
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { createSlackMonitorContext, normalizeSlackChannelType } from "./context.js";
import { resetSlackThreadStarterCacheForTest, resolveSlackThreadStarter } from "./media.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

describe("resolveSlackChannelConfig", () => {
  it("uses defaultRequireMention when channels config is empty", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: {},
      defaultRequireMention: false,
    });
    expect(res).toEqual({ allowed: true, requireMention: false });
  });

  it("defaults defaultRequireMention to true when not provided", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: {},
    });
    expect(res).toEqual({ allowed: true, requireMention: true });
  });

  it("prefers explicit channel/fallback requireMention over defaultRequireMention", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { "*": { requireMention: true } },
      defaultRequireMention: false,
    });
    expect(res).toMatchObject({ requireMention: true });
  });

  it("uses wildcard entries when no direct channel config exists", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { "*": { allow: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({
      allowed: true,
      requireMention: false,
      matchKey: "*",
      matchSource: "wildcard",
    });
  });

  it("uses direct match metadata when channel config exists", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { C1: { allow: true, requireMention: false } },
      defaultRequireMention: true,
    });
    expect(res).toMatchObject({
      matchKey: "C1",
      matchSource: "direct",
    });
  });
});

const baseParams = () => ({
  cfg: {} as OpenClawConfig,
  accountId: "default",
  botToken: "token",
  app: { client: {} } as App,
  runtime: {} as RuntimeEnv,
  botUserId: "B1",
  teamId: "T1",
  apiAppId: "A1",
  historyLimit: 0,
  sessionScope: "per-sender" as const,
  mainKey: "main",
  dmEnabled: true,
  dmPolicy: "open" as const,
  allowFrom: [],
  groupDmEnabled: true,
  groupDmChannels: [],
  defaultRequireMention: true,
  groupPolicy: "open" as const,
  useAccessGroups: false,
  reactionMode: "off" as const,
  reactionAllowlist: [],
  replyToMode: "off" as const,
  slashCommand: {
    enabled: false,
    name: "openclaw",
    sessionPrefix: "slack:slash",
    ephemeral: true,
  },
  textLimit: 4000,
  ackReactionScope: "group-mentions",
  mediaMaxBytes: 1,
  threadHistoryScope: "thread" as const,
  threadInheritParent: false,
  removeAckAfterReply: false,
});

describe("normalizeSlackChannelType", () => {
  it("infers channel types from ids when missing", () => {
    expect(normalizeSlackChannelType(undefined, "C123")).toBe("channel");
    expect(normalizeSlackChannelType(undefined, "D123")).toBe("im");
    expect(normalizeSlackChannelType(undefined, "G123")).toBe("group");
  });

  it("prefers explicit channel_type values", () => {
    expect(normalizeSlackChannelType("mpim", "C123")).toBe("mpim");
  });
});

describe("resolveSlackSystemEventSessionKey", () => {
  it("defaults missing channel_type to channel sessions", () => {
    const ctx = createSlackMonitorContext(baseParams());
    expect(ctx.resolveSlackSystemEventSessionKey({ channelId: "C123" })).toBe(
      "agent:main:slack:channel:c123",
    );
  });
});

describe("isChannelAllowed with groupPolicy and channelsConfig", () => {
  it("allows unlisted channels when groupPolicy is open even with channelsConfig entries", () => {
    // Bug fix: when groupPolicy="open" and channels has some entries,
    // unlisted channels should still be allowed (not blocked)
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      groupPolicy: "open",
      channelsConfig: {
        C_LISTED: { requireMention: true },
      },
    });
    // Listed channel should be allowed
    expect(ctx.isChannelAllowed({ channelId: "C_LISTED", channelType: "channel" })).toBe(true);
    // Unlisted channel should ALSO be allowed when policy is "open"
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(true);
  });

  it("blocks unlisted channels when groupPolicy is allowlist", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      groupPolicy: "allowlist",
      channelsConfig: {
        C_LISTED: { requireMention: true },
      },
    });
    // Listed channel should be allowed
    expect(ctx.isChannelAllowed({ channelId: "C_LISTED", channelType: "channel" })).toBe(true);
    // Unlisted channel should be blocked when policy is "allowlist"
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(false);
  });

  it("blocks explicitly denied channels even when groupPolicy is open", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      groupPolicy: "open",
      channelsConfig: {
        C_ALLOWED: { allow: true },
        C_DENIED: { allow: false },
      },
    });
    // Explicitly allowed channel
    expect(ctx.isChannelAllowed({ channelId: "C_ALLOWED", channelType: "channel" })).toBe(true);
    // Explicitly denied channel should be blocked even with open policy
    expect(ctx.isChannelAllowed({ channelId: "C_DENIED", channelType: "channel" })).toBe(false);
    // Unlisted channel should be allowed with open policy
    expect(ctx.isChannelAllowed({ channelId: "C_UNLISTED", channelType: "channel" })).toBe(true);
  });

  it("allows all channels when groupPolicy is open and channelsConfig is empty", () => {
    const ctx = createSlackMonitorContext({
      ...baseParams(),
      groupPolicy: "open",
      channelsConfig: undefined,
    });
    expect(ctx.isChannelAllowed({ channelId: "C_ANY", channelType: "channel" })).toBe(true);
  });
});

describe("resolveSlackThreadStarter cache", () => {
  afterEach(() => {
    resetSlackThreadStarterCacheForTest();
    vi.useRealTimers();
  });

  it("returns cached thread starter without refetching within ttl", async () => {
    const replies = vi.fn(async () => ({
      messages: [{ text: "root message", user: "U1", ts: "1000.1" }],
    }));
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const first = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });
    const second = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    expect(first).toEqual(second);
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it("expires stale cache entries and refetches after ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const replies = vi.fn(async () => ({
      messages: [{ text: "root message", user: "U1", ts: "1000.1" }],
    }));
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    vi.setSystemTime(new Date("2026-01-01T07:00:00.000Z"));
    await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest entries once cache exceeds bounded size", async () => {
    const replies = vi.fn(async () => ({
      messages: [{ text: "root message", user: "U1", ts: "1000.1" }],
    }));
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    // Cache cap is 2000; add enough distinct keys to force eviction of earliest keys.
    for (let i = 0; i <= 2000; i += 1) {
      await resolveSlackThreadStarter({
        channelId: "C1",
        threadTs: `1000.${i}`,
        client,
      });
    }
    const callsAfterFill = replies.mock.calls.length;

    // Oldest key should be evicted and require fetch again.
    await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.0",
      client,
    });

    expect(replies.mock.calls.length).toBe(callsAfterFill + 1);
  });
});

describe("createSlackThreadTsResolver", () => {
  it("caches resolved thread_ts lookups", async () => {
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: { conversations: { history: historyMock } } as any,
      cacheTtlMs: 60_000,
      maxSize: 5,
    });

    const message = {
      channel: "C1",
      parent_user_id: "U2",
      ts: "1",
    } as SlackMessageEvent;

    const first = await resolver.resolve({ message, source: "message" });
    const second = await resolver.resolve({ message, source: "message" });

    expect(first.thread_ts).toBe("9");
    expect(second.thread_ts).toBe("9");
    expect(historyMock).toHaveBeenCalledTimes(1);
  });
});

// --- freeResponseChannels tests ---

const defaultAccount: ResolvedSlackAccount = {
  accountId: "default",
  enabled: true,
  botTokenSource: "config",
  appTokenSource: "config",
  config: {},
};

vi.mock("../../../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
  updateLastRoute: vi.fn(),
  resolveSessionKey: vi.fn((scope, ctx, key) => key ?? "main"),
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../auto-reply/reply.js", () => ({
  getReplyFromConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn().mockResolvedValue({ code: "CODE", created: false }),
}));

function makeChannelCtx(overrides?: Partial<Parameters<typeof createSlackMonitorContext>[0]>) {
  return createSlackMonitorContext({
    ...baseParams(),
    botUserId: "BOT",
    dmEnabled: false,
    dmPolicy: "disabled",
    groupPolicy: "open",
    defaultRequireMention: true,
    app: {
      client: {
        conversations: {
          info: vi.fn().mockResolvedValue({ channel: { name: "general", is_channel: true } }),
        },
        users: {
          info: vi.fn().mockResolvedValue({ user: { profile: { display_name: "Alice" } } }),
        },
      },
    } as unknown as App,
    ...overrides,
  });
}

async function sendChannelMessage(
  ctx: ReturnType<typeof makeChannelCtx>,
  text: string,
  channel = "C1",
) {
  const msg: SlackMessageEvent = {
    type: "message",
    channel,
    channel_type: "channel",
    text,
    user: "U1",
    ts: "1000.001",
    event_ts: "1000.001",
  } as SlackMessageEvent;
  return prepareSlackMessage({
    ctx,
    account: defaultAccount,
    message: msg,
    opts: { source: "message", wasMentioned: false },
  });
}

describe("freeResponseChannels", () => {
  it("normalizes free response channel list from context params", () => {
    const ctx = makeChannelCtx({ freeResponseChannels: ["C1", "general"] });
    expect(ctx.freeResponseChannels).toEqual(["C1", "general"]);
  });

  it("defaults to empty array when not provided", () => {
    const ctx = makeChannelCtx({ freeResponseChannels: undefined });
    expect(ctx.freeResponseChannels).toEqual([]);
  });

  it("bypasses requireMention for channel in freeResponseChannels by ID", async () => {
    const ctx = makeChannelCtx({ freeResponseChannels: ["C1"] });
    // No @mention, requireMention=true globally, but C1 is free
    const result = await sendChannelMessage(ctx, "hello without mention", "C1");
    expect(result).not.toBeNull();
  });

  it("still requires mention for channels NOT in freeResponseChannels", async () => {
    const ctx = makeChannelCtx({ freeResponseChannels: ["C1"] });
    // C2 is not free, no mention → should be filtered
    const result = await sendChannelMessage(ctx, "hello without mention", "C2");
    expect(result).toBeNull();
  });

  it("bypasses requireMention for channel in freeResponseChannels by name with # prefix", async () => {
    const ctx = makeChannelCtx({ freeResponseChannels: ["#general"] });
    // resolveChannelName returns { name: "general" }; with #general in list
    const result = await sendChannelMessage(ctx, "hello", "C1");
    expect(result).not.toBeNull();
  });
});

describe("allowBots modes", () => {
  it("resolveSlackChannelConfig preserves allowBots mode string in resolved config", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { C1: { allowBots: "mentions" } },
    });
    expect(res?.allowBots).toBe("mentions");
  });

  it("resolveSlackChannelConfig preserves allowBots=all in resolved config", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { C1: { allowBots: "all" } },
    });
    expect(res?.allowBots).toBe("all");
  });

  it("drops bot messages when allowBots is none (false)", async () => {
    const ctx = makeChannelCtx({ freeResponseChannels: [], defaultRequireMention: false });
    const msg: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      text: "bot says hi",
      bot_id: "BOTHER",
      ts: "1000.001",
      event_ts: "1000.001",
    } as SlackMessageEvent;
    const result = await prepareSlackMessage({
      ctx,
      account: { ...defaultAccount, config: { allowBots: false } },
      message: msg,
      opts: { source: "message" },
    });
    expect(result).toBeNull();
  });

  it("accepts bot messages when allowBots is all (true)", async () => {
    const ctx = makeChannelCtx({ freeResponseChannels: [], defaultRequireMention: false });
    const msg: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      text: "bot says hi",
      bot_id: "BOTHER",
      ts: "1000.001",
      event_ts: "1000.001",
    } as SlackMessageEvent;
    const result = await prepareSlackMessage({
      ctx,
      account: { ...defaultAccount, config: { allowBots: true } },
      message: msg,
      opts: { source: "message" },
    });
    expect(result).not.toBeNull();
  });

  it("drops bot messages when allowBots=mentions and bot is not mentioned", async () => {
    const ctx = makeChannelCtx({ freeResponseChannels: [], defaultRequireMention: false });
    const msg: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      text: "bot says hi without mentioning <@BOT>",
      bot_id: "BOTHER",
      ts: "1000.001",
      event_ts: "1000.001",
    } as SlackMessageEvent;
    // Overwrite text so bot is NOT mentioned
    const textWithoutMention = "bot says hi without mention";
    const result = await prepareSlackMessage({
      ctx,
      account: { ...defaultAccount, config: { allowBots: "mentions" } },
      message: { ...msg, text: textWithoutMention },
      opts: { source: "message" },
    });
    expect(result).toBeNull();
  });

  it("accepts bot messages when allowBots=mentions and bot IS mentioned", async () => {
    const ctx = makeChannelCtx({ freeResponseChannels: [], defaultRequireMention: false });
    const msg: SlackMessageEvent = {
      type: "message",
      channel: "C1",
      channel_type: "channel",
      text: "<@BOT> please help",
      bot_id: "BOTHER",
      ts: "1000.002",
      event_ts: "1000.002",
    } as SlackMessageEvent;
    const result = await prepareSlackMessage({
      ctx,
      account: { ...defaultAccount, config: { allowBots: "mentions" } },
      message: msg,
      opts: { source: "message" },
    });
    expect(result).not.toBeNull();
  });
});
