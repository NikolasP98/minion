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
const tempDirs: string[] = [];

beforeAll(async () => {
  const started = await startServerWithClient();
  ws = started.ws;
  server = started.server;
  await connectOk(ws);
});

afterAll(async () => {
  ws?.close();
  if (server) {
    await server.close();
  }
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for condition");
}

describe("gateway multi-agent routing e2e", () => {
  test(
    "routes messages to different agents via session keys and maintains session isolation",
    { timeout: 30_000 },
    async () => {
      // Configure two agents: agent-a (default) and agent-b
      testState.agentsConfig = {
        list: [{ id: "agent-a", default: true }, { id: "agent-b" }],
      };

      // Create a temp session store
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minion-gw-multi-agent-"));
      tempDirs.push(dir);
      testState.sessionStorePath = path.join(dir, "sessions.json");

      // Seed session entries for both agents
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-agent-a-main",
            updatedAt: Date.now(),
          },
        },
        agentId: "agent-a",
      });

      // Write agent-b session entry into the same store file
      const rawStore = await fs.readFile(testState.sessionStorePath, "utf-8");
      const store = JSON.parse(rawStore) as Record<string, unknown>;
      store["agent:agent-b:main"] = {
        sessionId: "sess-agent-b-main",
        updatedAt: Date.now(),
      };
      await fs.writeFile(testState.sessionStorePath, JSON.stringify(store, null, 2), "utf-8");

      // Mock getReplyFromConfig to capture calls
      const spy = vi.mocked(getReplyFromConfig);
      spy.mockClear();
      const spyCalls = spy.mock.calls as unknown[][];

      // --- Send to default agent (agent-a) via session key "main" ---
      const callsBeforeA = spyCalls.length;
      const resA = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "msg-a",
        idempotencyKey: "idem-a",
      });
      expect(resA.ok).toBe(true);

      // Wait for the mock to be called for agent-a
      await waitFor(() => spyCalls.length > callsBeforeA);

      const ctxA = spyCalls.at(-1)?.[0] as { Body?: string; SessionKey?: string } | undefined;
      expect(ctxA?.Body).toBe("msg-a");
      // Default agent resolves "main" -> "agent:agent-a:main"
      expect(ctxA?.SessionKey).toBe("agent:agent-a:main");

      // --- Send to agent-b via explicit agent-prefixed session key ---
      const callsBeforeB = spyCalls.length;
      const resB = await rpcReq(ws, "chat.send", {
        sessionKey: "agent:agent-b:main",
        message: "msg-b",
        idempotencyKey: "idem-b",
      });
      expect(resB.ok).toBe(true);

      // Wait for the mock to be called for agent-b
      await waitFor(() => spyCalls.length > callsBeforeB);

      const ctxB = spyCalls.at(-1)?.[0] as { Body?: string; SessionKey?: string } | undefined;
      expect(ctxB?.Body).toBe("msg-b");
      expect(ctxB?.SessionKey).toBe("agent:agent-b:main");

      // Verify session isolation: the two calls targeted different session keys
      expect(ctxA?.SessionKey).not.toBe(ctxB?.SessionKey);

      // Verify at least two separate calls were made
      expect(spyCalls.length).toBeGreaterThanOrEqual(2);
    },
  );
});
