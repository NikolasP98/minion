import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalHookEvent } from "../../internal-hooks.js";
import handler from "./handler.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join("/tmp", "vh-handler-test-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeEvent(overrides?: Partial<InternalHookEvent>): InternalHookEvent {
  return {
    type: "message",
    action: "sent",
    sessionKey: "agent:main:main",
    timestamp: new Date(),
    messages: [],
    context: {
      content: "```typescript\nconst x = 1;\n```",
      channelId: "telegram",
      to: "user123",
      success: true,
    },
    ...overrides,
  };
}

describe("validation-harness handler", () => {
  it("ignores non-message events", async () => {
    const event = makeEvent({ type: "command", action: "new" });
    await handler(event);
    // No artifacts written — workspace dir not even created
    const dir = path.join(tmpDir, "workspace", "memory", "validation");
    const exists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("ignores message:received events", async () => {
    const event = makeEvent({ action: "received" });
    await handler(event);
    const dir = path.join(tmpDir, "workspace", "memory", "validation");
    const exists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("ignores failed sends", async () => {
    const event = makeEvent({
      context: {
        content: "```typescript\nconst x = 1;\n```",
        channelId: "telegram",
        to: "user123",
        success: false,
      },
    });
    await handler(event);
    const dir = path.join(tmpDir, "workspace", "memory", "validation");
    const exists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("ignores empty content", async () => {
    const event = makeEvent({
      context: {
        content: "   ",
        channelId: "telegram",
        to: "user123",
        success: true,
      },
    });
    await handler(event);
    const dir = path.join(tmpDir, "workspace", "memory", "validation");
    const exists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("writes artifacts for a successful message:sent event", async () => {
    const event = makeEvent();
    await handler(event);
    const validationDir = path.join(tmpDir, "workspace", "memory", "validation");
    const files = await fs.readdir(validationDir);
    expect(files.some((f) => f.startsWith("validation-harness-"))).toBe(true);
    expect(files.some((f) => f.startsWith("validation-summary-"))).toBe(true);
  });

  it("appends validation Markdown comment to event.messages", async () => {
    const event = makeEvent();
    await handler(event);
    expect(event.messages.length).toBeGreaterThan(0);
    expect(event.messages[0]).toContain("Validation Harness Result");
  });

  it("uses runId from context as task ID when available", async () => {
    const event = makeEvent({
      context: {
        content: "```typescript\nconst x = 1;\n```",
        channelId: "telegram",
        to: "user123",
        success: true,
        runId: "my-run-id-123",
      },
    });
    await handler(event);
    const validationDir = path.join(tmpDir, "workspace", "memory", "validation");
    const files = await fs.readdir(validationDir);
    expect(files.some((f) => f.includes("my-run-id-123"))).toBe(true);
  });

  it("handles errors gracefully without throwing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Force an error by pointing to an unwritable path
    process.env.OPENCLAW_STATE_DIR = "/nonexistent/readonly/path/xyz";
    const event = makeEvent();
    await expect(handler(event)).resolves.not.toThrow();
    consoleSpy.mockRestore();
  });
});
