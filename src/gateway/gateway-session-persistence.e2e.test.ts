import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let envSnapshot: Awaited<ReturnType<typeof startServerWithClient>>["envSnapshot"];
let tempSessionDir: string | undefined;

beforeAll(async () => {
  const started = await startServerWithClient();
  ws = started.ws;
  server = started.server;
  envSnapshot = started.envSnapshot;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
  envSnapshot.restore();
  if (tempSessionDir) {
    await fs.rm(tempSessionDir, { recursive: true, force: true });
  }
});

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout waiting for condition");
}

describe("gateway session persistence e2e", () => {
  test(
    "session is created, persisted to disk via agent run, and survives a second message",
    { timeout: 60_000 },
    async () => {
      // 1. Create a temp session store directory and pre-seed a session entry
      tempSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-persistence-"));
      const storePath = path.join(tempSessionDir, "sessions.json");
      testState.sessionStorePath = storePath;

      const sessionId = "sess-persist-test";
      await writeSessionStore({
        entries: {
          main: {
            sessionId,
            updatedAt: Date.now(),
          },
        },
      });

      // Write an initial transcript file so the session has content
      const transcriptPath = path.join(tempSessionDir, `${sessionId}.jsonl`);
      const header = JSON.stringify({
        type: "session",
        version: 1,
        id: sessionId,
      });
      await fs.writeFile(transcriptPath, `${header}\n`, "utf-8");

      // 2. Set up getReplyFromConfig mock to simulate a tool call + reply
      const spy = vi.mocked(getReplyFromConfig);
      spy.mockClear();

      let firstCallSessionKey: string | undefined;
      let secondCallSessionKey: string | undefined;
      let callCount = 0;

      spy.mockImplementation(async (ctx) => {
        callCount++;
        const sessionKey = typeof ctx.SessionKey === "string" ? ctx.SessionKey : undefined;
        if (callCount === 1) {
          firstCallSessionKey = sessionKey;
        } else if (callCount === 2) {
          secondCallSessionKey = sessionKey;
        }
        // Return a reply to simulate the agent producing output
        return { text: `mock reply ${callCount}` };
      });

      // 3. Send first chat.send message
      const firstRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "first message for persistence test",
        idempotencyKey: "idem-persist-1",
      });
      expect(firstRes.ok).toBe(true);

      // 4. Wait for getReplyFromConfig to be called (async dispatch)
      await waitFor(() => callCount >= 1, 10_000);

      // Allow a moment for the async dispatch to complete (transcript append, etc.)
      await new Promise((r) => setTimeout(r, 200));

      // 5. Verify session key was resolved correctly for the first message
      expect(firstCallSessionKey).toContain("main");

      // 6. Verify the session store file still exists on disk with correct entry
      const storeRaw = await fs.readFile(storePath, "utf-8");
      const store = JSON.parse(storeRaw) as Record<
        string,
        { sessionId?: string; updatedAt?: number }
      >;
      const mainEntry = Object.entries(store).find(([key]) => key.includes("main"));
      expect(mainEntry).toBeDefined();
      expect(mainEntry![1].sessionId).toBe(sessionId);

      // 7. Send a second chat.send to verify session continuity
      const secondRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "second message for persistence test",
        idempotencyKey: "idem-persist-2",
      });
      expect(secondRes.ok).toBe(true);

      // 8. Wait for the second call to be processed
      await waitFor(() => callCount >= 2, 10_000);

      // Allow async processing to complete
      await new Promise((r) => setTimeout(r, 200));

      // 9. Verify session continuity: both calls received the same session key
      expect(secondCallSessionKey).toBe(firstCallSessionKey);

      // 10. Re-read the store to confirm the same sessionId persists
      const updatedStoreRaw = await fs.readFile(storePath, "utf-8");
      const updatedStore = JSON.parse(updatedStoreRaw) as Record<
        string,
        { sessionId?: string; updatedAt?: number }
      >;
      const updatedMainEntry = Object.entries(updatedStore).find(([key]) => key.includes("main"));
      expect(updatedMainEntry).toBeDefined();
      expect(updatedMainEntry![1].sessionId).toBe(sessionId);

      // 11. Verify the transcript file was written to (reply appended)
      const transcriptContent = await fs.readFile(transcriptPath, "utf-8");
      const transcriptLines = transcriptContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
      // Should have more than just the header — the reply was appended
      expect(transcriptLines.length).toBeGreaterThan(1);

      // Clean up test state
      testState.sessionStorePath = undefined;
    },
  );
});
