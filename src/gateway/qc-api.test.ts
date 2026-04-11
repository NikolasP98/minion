import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./auth/auth.js", () => ({
  authorizeGatewayConnect: async () => ({ ok: true }),
}));

vi.mock("../logger.js", () => ({
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {},
}));

import { ensureQcSchema } from "../pipeline/qc-db.js";
import { processInspection, type InspectResult } from "../pipeline/qc-workflow.js";
import { handleQcApiRequest, resetQcDb, setQcDb } from "./qc-api.js";

// ── Test Servers ────────────────────────────────────────────────────────────

let sidecarServer: ReturnType<typeof createServer>;
let sidecarPort: number;
let gatewayServer: ReturnType<typeof createServer>;
let gatewayPort: number;
let testDb: DatabaseSync;

beforeAll(async () => {
  // Test DB
  testDb = new DatabaseSync(":memory:");
  ensureQcSchema(testDb);
  setQcDb(testDb);

  // Fake ViT inference sidecar
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
        // Simulate: "defect_image" → defect detected, anything else → pass
        const isDefect = parsed.image === "defect_image";
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            defectType: isDefect ? "bottle_crack" : "none",
            confidence: isDefect ? 0.92 : 0.98,
            boundingBox: null,
            pass: !isDefect,
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

  // Gateway test server
  gatewayServer = createServer(async (req, res) => {
    const handled = await handleQcApiRequest(req, res, {
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
  testDb?.close();
  resetQcDb();
  delete process.env.INSPECT_SERVICE_URL;
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/qc/inspect", () => {
  it("classifies a passing image correctly", async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/api/qc/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ image: "good_image", imageRef: "test-pass.png" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routing).toBe("pass");
    expect(body.quarantine).toBe(false);
    expect(body.alertFired).toBe(false);
    expect(body.inspectionId).toBeDefined();
    expect(body.batchId).toBeDefined();
  });

  it("classifies a defective image and fires alert", async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/api/qc/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ image: "defect_image", imageRef: "test-fail.png" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routing).toBe("fail");
    expect(body.quarantine).toBe(true);
    expect(body.alertFired).toBe(true);
    expect(body.defectType).toBe("bottle_crack");
  });

  it("rejects missing image field", async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/api/qc/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("rejects non-POST methods", async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/api/qc/inspect`, {
      method: "GET",
      headers: { Authorization: "Bearer test" },
    });

    expect(res.status).toBe(405);
  });
});

describe("GET /api/qc/thresholds", () => {
  it("returns current threshold configuration", async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/api/qc/thresholds`, {
      headers: { Authorization: "Bearer test" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passThreshold).toBeDefined();
    expect(body.failThreshold).toBeDefined();
    expect(body.batchSize).toBeDefined();
    expect(body.failThreshold).toBeLessThan(body.passThreshold);
  });
});

describe("GET /api/qc/batch/:id/report", () => {
  it("returns 404 for nonexistent batch", async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/api/qc/batch/nonexistent/report`, {
      headers: { Authorization: "Bearer test" },
    });

    expect(res.status).toBe(404);
  });

  it("generates report for a batch with inspections", async () => {
    // Create a batch by running inspections through the workflow directly
    const thresholds = { passThreshold: 0.95, failThreshold: 0.7, batchSize: 100 };
    const passResult: InspectResult = { defectType: "none", confidence: 0.98, boundingBox: null, pass: true };
    const failResult: InspectResult = { defectType: "crack", confidence: 0.85, boundingBox: null, pass: false };

    const out1 = processInspection(testDb, passResult, "r1.png", thresholds);
    processInspection(testDb, failResult, "r2.png", thresholds);

    const res = await fetch(`http://localhost:${gatewayPort}/api/qc/batch/${out1.batchId}/report`, {
      headers: { Authorization: "Bearer test" },
    });

    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.batchId).toBe(out1.batchId);
    expect(report.summary.totalInspections).toBeGreaterThanOrEqual(2);
    expect(report.defectLog.length).toBeGreaterThanOrEqual(2);
    expect(report.summary.alertCount).toBeGreaterThanOrEqual(1);
  });
});

describe("non-matching routes", () => {
  it("does not match non-QC paths", async () => {
    const res = await fetch(`http://localhost:${gatewayPort}/api/other`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: "test" }),
    });

    expect(res.status).toBe(404);
  });
});
