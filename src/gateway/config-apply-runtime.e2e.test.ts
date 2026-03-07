import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startGatewayServer>>;
let port = 0;

beforeAll(async () => {
  port = await getFreePort();
  server = await startGatewayServer(port, { controlUiEnabled: true });
});

afterAll(async () => {
  await server.close();
});

const openClient = async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws);
  return ws;
};

describe("gateway config apply runtime e2e", () => {
  it("applies a model config change via config.set", async () => {
    const ws = await openClient();
    try {
      const setRes = await rpcReq<{ ok?: boolean }>(ws, "config.set", {
        raw: JSON.stringify({
          ai: {
            model: "claude-sonnet-4-20250514",
          },
        }),
      });
      expect(setRes.ok).toBe(true);

      const getRes = await rpcReq<{ raw?: string; hash?: string }>(ws, "config.get", {});
      expect(getRes.ok).toBe(true);
      expect(getRes.payload?.raw).toBeDefined();
      const parsed = JSON.parse(getRes.payload!.raw!);
      expect(parsed.ai?.model).toBe("claude-sonnet-4-20250514");
    } finally {
      ws.close();
    }
  });

  it("rejects invalid JSON in config.apply", async () => {
    const ws = await openClient();
    try {
      const id = "invalid-json-1";
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "config.apply",
          params: {
            raw: "{",
          },
        }),
      );
      const res = await onceMessage<{ ok: boolean; error?: { message?: string } }>(ws, (o) => {
        const msg = o as { type?: string; id?: string };
        return msg.type === "res" && msg.id === id;
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toMatch(/invalid|SyntaxError/i);
    } finally {
      ws.close();
    }
  });

  it("preserves previous config after rejected apply", async () => {
    const ws = await openClient();
    try {
      // Set a known valid config
      const setRes = await rpcReq<{ ok?: boolean }>(ws, "config.set", {
        raw: JSON.stringify({
          ai: {
            model: "claude-sonnet-4-20250514",
          },
        }),
      });
      expect(setRes.ok).toBe(true);

      // Snapshot the config before the invalid apply
      const beforeRes = await rpcReq<{ raw?: string; hash?: string }>(ws, "config.get", {});
      expect(beforeRes.ok).toBe(true);
      const beforeRaw = beforeRes.payload?.raw;

      // Attempt an invalid apply (malformed JSON)
      const id = "invalid-apply-rollback";
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "config.apply",
          params: {
            raw: "{",
          },
        }),
      );
      const applyRes = await onceMessage<{ ok: boolean; error?: { message?: string } }>(ws, (o) => {
        const msg = o as { type?: string; id?: string };
        return msg.type === "res" && msg.id === id;
      });
      expect(applyRes.ok).toBe(false);

      // Verify the config is unchanged
      const afterRes = await rpcReq<{ raw?: string; hash?: string }>(ws, "config.get", {});
      expect(afterRes.ok).toBe(true);
      expect(afterRes.payload?.raw).toBe(beforeRaw);
    } finally {
      ws.close();
    }
  });
});
