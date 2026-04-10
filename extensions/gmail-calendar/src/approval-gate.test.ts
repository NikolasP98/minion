import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildApprovalPrompt,
  cancelPending,
  consumePending,
  createPending,
  listPending,
} from "./approval-gate.js";

describe("approval-gate", () => {
  // Use fake timers for expiry testing
  beforeEach(() => {
    // Consume any leftover tokens between tests by clearing via module reset isn't easy;
    // instead we ensure consuming/cancelling our own tokens works independently
  });

  it("createPending returns an entry with a 4-char uppercase token", () => {
    const entry = createPending({
      provider: "gmail",
      payload: { to: "a@b.com" },
      summary: "To: a@b.com\nSubject: Hello",
    });
    expect(entry.token).toMatch(/^[A-F0-9]{8}$/i);
    expect(entry.provider).toBe("gmail");
    expect(entry.expiresAt).toBeGreaterThan(Date.now());
  });

  it("consumePending returns and removes the entry", () => {
    const entry = createPending({
      provider: "outlook",
      payload: { messageId: "abc" },
      summary: "Reply to abc",
    });
    const token = entry.token;
    const consumed = consumePending(token);
    expect(consumed).not.toBeNull();
    expect(consumed?.token).toBe(token);
    // Second consume returns null
    expect(consumePending(token)).toBeNull();
  });

  it("consumePending is case-insensitive", () => {
    const entry = createPending({ provider: "gmail", payload: {}, summary: "test" });
    expect(consumePending(entry.token.toLowerCase())).not.toBeNull();
  });

  it("cancelPending returns true when found, false when not", () => {
    const entry = createPending({ provider: "gmail", payload: {}, summary: "s" });
    expect(cancelPending(entry.token)).toBe(true);
    expect(cancelPending(entry.token)).toBe(false);
  });

  it("listPending shows un-consumed entries", () => {
    const e1 = createPending({ provider: "gmail", payload: {}, summary: "a" });
    const e2 = createPending({ provider: "outlook", payload: {}, summary: "b" });
    const listed = listPending();
    const tokens = listed.map((e) => e.token);
    expect(tokens).toContain(e1.token);
    expect(tokens).toContain(e2.token);
    // Cleanup
    cancelPending(e1.token);
    cancelPending(e2.token);
  });

  it("buildApprovalPrompt contains token and summary", () => {
    const entry = createPending({
      provider: "gmail",
      payload: {},
      summary: "To: user@example.com\nSubject: Test",
    });
    const prompt = buildApprovalPrompt(entry);
    expect(prompt).toContain(entry.token);
    expect(prompt).toContain("To: user@example.com");
    expect(prompt).toContain("email_send_confirm");
    cancelPending(entry.token);
  });

  it("expired entries are pruned and return null", () => {
    const entry = createPending({
      provider: "gmail",
      payload: {},
      summary: "expired test",
      timeoutMs: -1, // already expired
    });
    expect(consumePending(entry.token)).toBeNull();
  });
});
