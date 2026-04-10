import { describe, expect, it } from "vitest";
import {
  extractToolErrorMessage,
  extractToolResultText,
  sanitizeToolResult,
} from "./pi-embedded-subscribe.tools.js";

describe("extractToolResultText — structuredContent fallback", () => {
  it("returns text from content blocks when present", () => {
    const result = { content: [{ type: "text", text: "hello world" }] };
    expect(extractToolResultText(result)).toBe("hello world");
  });

  it("falls back to JSON-serialised structuredContent when content is absent", () => {
    const result = { structuredContent: { filePath: "/etc/hosts", fileText: "127.0.0.1 localhost" } };
    expect(extractToolResultText(result)).toBe(
      JSON.stringify({ filePath: "/etc/hosts", fileText: "127.0.0.1 localhost" }),
    );
  });

  it("falls back to structuredContent string without re-wrapping", () => {
    const result = { structuredContent: "plain text from server" };
    expect(extractToolResultText(result)).toBe("plain text from server");
  });

  it("prefers content over structuredContent when both are present", () => {
    const result = {
      content: [{ type: "text", text: "content wins" }],
      structuredContent: { ignored: true },
    };
    expect(extractToolResultText(result)).toBe("content wins");
  });

  it("returns undefined when both content and structuredContent are absent", () => {
    expect(extractToolResultText({})).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(extractToolResultText(null)).toBeUndefined();
    expect(extractToolResultText("string")).toBeUndefined();
  });
});

describe("sanitizeToolResult — structuredContent fallback", () => {
  it("synthesises a content array from structuredContent when content is absent", () => {
    const result = { isError: false, structuredContent: { key: "value" } };
    const sanitized = sanitizeToolResult(result) as Record<string, unknown>;
    expect(Array.isArray(sanitized.content)).toBe(true);
    const blocks = sanitized.content as Array<{ type: string; text: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.text).toBe(JSON.stringify({ key: "value" }));
  });

  it("does not use structuredContent when content array is already present", () => {
    const result = {
      content: [{ type: "text", text: "original" }],
      structuredContent: { should: "be ignored" },
    };
    const sanitized = sanitizeToolResult(result) as Record<string, unknown>;
    const blocks = sanitized.content as Array<{ type: string; text: string }>;
    expect(blocks[0]?.text).toBe("original");
  });

  it("returns record unchanged when neither content nor structuredContent is present", () => {
    const result = { isError: false };
    expect(sanitizeToolResult(result)).toEqual({ isError: false });
  });
});

describe("extractToolErrorMessage", () => {
  it("ignores non-error status values", () => {
    expect(extractToolErrorMessage({ details: { status: "0" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "completed" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "ok" } })).toBeUndefined();
  });

  it("keeps error-like status values", () => {
    expect(extractToolErrorMessage({ details: { status: "failed" } })).toBe("failed");
    expect(extractToolErrorMessage({ details: { status: "timeout" } })).toBe("timeout");
  });
});
