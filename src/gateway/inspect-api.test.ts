import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./auth/auth.js", () => ({
  authorizeGatewayConnect: async () => ({ ok: true }),
}));

vi.mock("../logger.js", () => ({
  logInfo: () => {},
  logError: () => {},
}));

import { handleInspectApiRequest } from "./inspect-api.js";

// Fake sidecar server
let sidecarServer: ReturnType<typeof createServer>;
let sidecarPort: number;

// Gateway test server
let gatewayServer: ReturnType<typeof createServer>;
let gatewayPort: number;

beforeAll(async () => {
  // Start a fake ViT inference sidecar
  sidecarServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/predict" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        if (!parsed.image) {
          res.statusCode = 400;
          res.end(JSON.stringify({ detail: "Missing image" }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            defectType: "bottle_defect",
            confidence: 0.9812,
            boundingBox: null,
            pass: false,
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end("Not Found");
  });

  await new Promise<void>((resolve) => {
    sidecarServer.listen(0, () => {
      sidecarPort = (sidecarServer.address() as AddressInfo).port;
      process.env.INSPECT_SERVICE_URL = `http://localhost:${sidecarPort}`;
      resolve();
    });
  });

  // Start a minimal gateway server that only routes to inspect handler
  gatewayServer = createServer(async (req, res) => {
    const handled = await handleInspectApiRequest(req, res, {
      auth: {} as never,
      trustedProxies: [],
      rateLimiter: {} as never,
    });
    if (!handled) {
      res.statusCode = 404;
      res.end("Not Found");
    }
  });

  await new Promise<void>((resolve) => {
    gatewayServer.listen(0, () => {
      gatewayPort = (gatewayServer.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  sidecarServer?.close();
  gatewayServer?.close();
  delete process.env.INSPECT_SERVICE_URL;
});

describe("POST /api/inspect", () => {
  it("returns defect classification for a valid image", async () => {
    // 1x1 red PNG as base64
    const testImageBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

    const res = await fetch(`http://localhost:${gatewayPort}/api/inspect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ image: testImageBase64 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      defectType: "bottle_defect",
      confidence: 0.9812,
      boundingBox: null,
      pass: false,
    });
  });

  it("rejects requests without image field", async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/api/inspect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects non-POST methods", async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/api/inspect`, {
      method: "GET",
      headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(405);
  });

  it("does not match other paths", async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/api/other`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: "test" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 503 when sidecar is unreachable", async () => {
    const originalUrl = process.env.INSPECT_SERVICE_URL;
    process.env.INSPECT_SERVICE_URL = "http://localhost:1"; // unreachable port

    const res = await fetch(`http://localhost:${gatewayPort}/api/inspect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ image: "dGVzdA==" }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.type).toBe("inspect_unavailable");

    process.env.INSPECT_SERVICE_URL = originalUrl;
  });
});
