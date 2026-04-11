/**
 * QC API endpoints — orchestrates the QC agent workflow over HTTP.
 *
 * Endpoints:
 * - POST /api/qc/inspect    — Submit frame, run classification + routing
 * - GET  /api/qc/batch/:id   — Get batch status
 * - GET  /api/qc/batch/:id/report — Generate batch inspection report
 * - GET  /api/qc/thresholds  — Get current QC threshold configuration
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { logError, logInfo, logWarn } from "../logger.js";
import { loadQcThresholds } from "../pipeline/qc-config.js";
import { ensureQcSchema, getBatch, getOpenBatch } from "../pipeline/qc-db.js";
import { generateBatchReport } from "../pipeline/qc-report.js";
import { processInspection, type InspectResult } from "../pipeline/qc-workflow.js";
import type { AuthRateLimiter } from "./auth/auth-rate-limit.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth/auth.js";
import { readJsonBodyOrError, sendGatewayAuthFailure, sendJson, sendMethodNotAllowed } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

const QC_PATH_PREFIX = "/api/qc";
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 5_000;

type QcApiOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  rateLimiter?: AuthRateLimiter;
};

// ── Database Singleton ──────────────────────────────────────────────────────

let qcDb: DatabaseSync | undefined;

function getQcDb(): DatabaseSync {
  if (!qcDb) {
    const dbPath = process.env.QC_DB_PATH ?? ":memory:";
    qcDb = new DatabaseSync(dbPath);
    ensureQcSchema(qcDb);
  }
  return qcDb;
}

/** Reset the DB singleton (for testing). */
export function resetQcDb(): void {
  qcDb = undefined;
}

/** Inject a DB instance (for testing). */
export function setQcDb(db: DatabaseSync): void {
  qcDb = db;
}

// ── Inspect Service Proxy ───────────────────────────────────────────────────

function getInspectServiceUrl(): string {
  return process.env.INSPECT_SERVICE_URL ?? "http://localhost:8100";
}

async function callInspectService(imageBase64: string): Promise<InspectResult> {
  const serviceUrl = getInspectServiceUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const proxyRes = await fetch(`${serviceUrl}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageBase64 }),
      signal: controller.signal,
    });

    if (!proxyRes.ok) {
      const errorText = await proxyRes.text().catch(() => "Unknown error");
      throw new Error(`Sidecar returned ${proxyRes.status}: ${errorText}`);
    }

    return (await proxyRes.json()) as InspectResult;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Request Handler ─────────────────────────────────────────────────────────

export async function handleQcApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: QcApiOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(QC_PATH_PREFIX)) {
    return false;
  }

  // Auth check for all QC endpoints
  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: token ? { token, password: token } : null,
    req,
    trustedProxies: opts.trustedProxies,
    rateLimiter: opts.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return true;
  }

  const subPath = url.pathname.slice(QC_PATH_PREFIX.length);

  // POST /api/qc/inspect
  if (subPath === "/inspect") {
    return handleQcInspect(req, res);
  }

  // GET /api/qc/thresholds
  if (subPath === "/thresholds") {
    return handleQcThresholds(req, res);
  }

  // GET /api/qc/batch/:id
  const batchMatch = subPath.match(/^\/batch\/([^/]+)$/);
  if (batchMatch) {
    return handleGetBatch(req, res, batchMatch[1]!);
  }

  // GET /api/qc/batch/:id/report
  const reportMatch = subPath.match(/^\/batch\/([^/]+)\/report$/);
  if (reportMatch) {
    return handleBatchReport(req, res, reportMatch[1]!);
  }

  // Unknown QC sub-route
  sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
  return true;
}

// ── Endpoint Handlers ───────────────────────────────────────────────────────

async function handleQcInspect(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const body = (await readJsonBodyOrError(req, res, MAX_BODY_BYTES)) as
    | { image?: unknown; imageRef?: unknown }
    | undefined;
  if (!body) return true;

  if (typeof body.image !== "string" || body.image.length === 0) {
    sendJson(res, 400, {
      error: { message: 'Missing or invalid "image" field (expected base64 string)', type: "invalid_request_error" },
    });
    return true;
  }

  const imageRef = typeof body.imageRef === "string" ? body.imageRef : `frame-${Date.now()}`;

  try {
    const inspectResult = await callInspectService(body.image);
    const thresholds = loadQcThresholds();
    const db = getQcDb();

    const result = processInspection(db, inspectResult, imageRef, thresholds, (alert) => {
      logWarn(`qc-api: Alert fired — ${alert.message}`);
    });

    logInfo(`qc-api: Inspection ${result.inspectionId} routed as ${result.routing}`);

    sendJson(res, 200, {
      inspectionId: result.inspectionId,
      batchId: result.batchId,
      routing: result.routing,
      defectType: result.defectType,
      confidence: result.confidence,
      quarantine: result.quarantine,
      alertFired: result.alertFired,
      batchClosed: result.batchClosed,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Inspection service timeout"
        : err instanceof Error
          ? err.message
          : "Inspection service unavailable";
    logError(`qc-api: ${message}`);
    sendJson(res, 503, {
      error: { message, type: "inspect_unavailable" },
    });
  }

  return true;
}

function handleQcThresholds(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const thresholds = loadQcThresholds();
  sendJson(res, 200, thresholds);
  return true;
}

function handleGetBatch(req: IncomingMessage, res: ServerResponse, batchId: string): boolean {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const db = getQcDb();
  const batch = getBatch(db, batchId);
  if (!batch) {
    sendJson(res, 404, { error: { message: "Batch not found", type: "not_found" } });
    return true;
  }

  sendJson(res, 200, batch);
  return true;
}

function handleBatchReport(req: IncomingMessage, res: ServerResponse, batchId: string): boolean {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const db = getQcDb();
  const report = generateBatchReport(db, batchId);
  if (!report) {
    sendJson(res, 404, { error: { message: "Batch not found", type: "not_found" } });
    return true;
  }

  sendJson(res, 200, report);
  return true;
}
