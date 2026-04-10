import { describe, it, expect } from "vitest";
import { normalizeWeixinMessage, resolveOutboundTarget } from "./normalize.js";
import type { WeixinInboundMessage } from "./types.js";

describe("normalizeWeixinMessage", () => {
  const botUin = "bot123";

  function makeMessage(overrides: Partial<WeixinInboundMessage> = {}): WeixinInboundMessage {
    return {
      type: 1,
      fromUin: "sender456",
      fromNickname: "Alice",
      text: "hello",
      contextToken: "ctx-abc",
      timestamp: 1712784000,
      ...overrides,
    };
  }

  it("should normalize a DM text message", () => {
    const msg = makeMessage();
    const result = normalizeWeixinMessage(msg, botUin);

    expect(result.body).toBe("hello");
    expect(result.rawBody).toBe("hello");
    expect(result.from).toBe("sender456");
    expect(result.to).toBe("bot123");
    expect(result.senderName).toBe("Alice");
    expect(result.senderId).toBe("sender456");
    expect(result.chatType).toBe("direct");
    expect(result.chatId).toBeUndefined();
    expect(result.provider).toBe("weixin");
    expect(result.surface).toBe("weixin");
    expect(result.contextToken).toBe("ctx-abc");
    expect(result.timestamp).toBe(1712784000);
    expect(result.mediaType).toBeUndefined();
  });

  it("should normalize a group message", () => {
    const msg = makeMessage({ chatId: "group789", chatName: "Team Chat" });
    const result = normalizeWeixinMessage(msg, botUin);

    expect(result.chatType).toBe("group");
    expect(result.chatId).toBe("group789");
    expect(result.chatName).toBe("Team Chat");
  });

  it("should use fromUin as senderName when nickname is missing", () => {
    const msg = makeMessage({ fromNickname: undefined });
    const result = normalizeWeixinMessage(msg, botUin);

    expect(result.senderName).toBe("sender456");
  });

  it("should handle empty text", () => {
    const msg = makeMessage({ text: undefined });
    const result = normalizeWeixinMessage(msg, botUin);

    expect(result.body).toBe("");
    expect(result.rawBody).toBe("");
  });

  it("should detect image media type", () => {
    const msg = makeMessage({ type: 2, mediaKey: "img-key", mediaAesKey: "aes-key" });
    const result = normalizeWeixinMessage(msg, botUin);

    expect(result.mediaType).toBe("image");
    expect(result.mediaKey).toBe("img-key");
    expect(result.mediaAesKey).toBe("aes-key");
  });

  it("should detect voice media type", () => {
    const msg = makeMessage({ type: 3 });
    const result = normalizeWeixinMessage(msg, botUin);
    expect(result.mediaType).toBe("voice");
  });

  it("should detect file media type", () => {
    const msg = makeMessage({ type: 4 });
    const result = normalizeWeixinMessage(msg, botUin);
    expect(result.mediaType).toBe("file");
  });

  it("should detect video media type", () => {
    const msg = makeMessage({ type: 5 });
    const result = normalizeWeixinMessage(msg, botUin);
    expect(result.mediaType).toBe("video");
  });

  it("should have no media type for text messages", () => {
    const msg = makeMessage({ type: 1 });
    const result = normalizeWeixinMessage(msg, botUin);
    expect(result.mediaType).toBeUndefined();
  });
});

describe("resolveOutboundTarget", () => {
  it("should return group target for group messages", () => {
    const ctx = normalizeWeixinMessage(
      {
        type: 1,
        fromUin: "sender456",
        chatId: "group789",
        text: "hello",
        contextToken: "ctx-abc",
        timestamp: 1712784000,
      },
      "bot123",
    );

    expect(resolveOutboundTarget(ctx)).toBe("group:group789");
  });

  it("should return user target for DM messages", () => {
    const ctx = normalizeWeixinMessage(
      {
        type: 1,
        fromUin: "sender456",
        text: "hello",
        contextToken: "ctx-abc",
        timestamp: 1712784000,
      },
      "bot123",
    );

    expect(resolveOutboundTarget(ctx)).toBe("user:sender456");
  });
});
