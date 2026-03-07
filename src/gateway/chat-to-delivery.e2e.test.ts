import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];

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

describe("gateway chat-to-delivery e2e", () => {
  test(
    "chat.send triggers getReplyFromConfig and delivers response back to client",
    async () => {
      const spy = vi.mocked(getReplyFromConfig);
      spy.mockClear();
      spy.mockImplementation(async () => ({ text: "test reply from agent" }));

      const spyCalls = spy.mock.calls as unknown[][];
      const callsBefore = spyCalls.length;

      // Send a chat message
      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-1",
      });
      expect(res.ok).toBe(true);

      // Wait for getReplyFromConfig to be called
      await waitFor(() => spyCalls.length > callsBefore);

      // Verify the mock was called with the expected context
      const ctx = spyCalls.at(-1)?.[0] as
        | { Body?: string; Provider?: string; SessionKey?: string }
        | undefined;
      expect(ctx?.Body).toBe("hello");
      expect(ctx?.Provider).toBe("webchat");

      // Wait for the delivery event back to the client
      const deliveryEvt = await onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat" &&
          o.payload?.runId === "idem-1" &&
          o.payload?.state === "final",
        10_000,
      );
      expect(deliveryEvt).toBeDefined();
      expect(deliveryEvt.payload?.runId).toBe("idem-1");
    },
    { timeout: 30_000 },
  );

  test(
    "handles sequential messages through the pipeline",
    async () => {
      const spy = vi.mocked(getReplyFromConfig);
      spy.mockClear();
      spy.mockImplementation(async () => ({ text: "second reply" }));

      const spyCalls = spy.mock.calls as unknown[][];
      const callsBefore = spyCalls.length;

      // Send a second message to verify sequential handling
      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "follow up message",
        idempotencyKey: "idem-2",
      });
      expect(res.ok).toBe(true);

      // Wait for getReplyFromConfig to be called
      await waitFor(() => spyCalls.length > callsBefore);

      // Verify the second message context
      const ctx = spyCalls.at(-1)?.[0] as { Body?: string; Provider?: string } | undefined;
      expect(ctx?.Body).toBe("follow up message");
      expect(ctx?.Provider).toBe("webchat");

      // Wait for the delivery event
      const deliveryEvt = await onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat" &&
          o.payload?.runId === "idem-2" &&
          o.payload?.state === "final",
        10_000,
      );
      expect(deliveryEvt).toBeDefined();
      expect(deliveryEvt.payload?.runId).toBe("idem-2");
    },
    { timeout: 30_000 },
  );
});
