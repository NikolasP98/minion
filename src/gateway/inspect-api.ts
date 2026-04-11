/**
 * /api/inspect endpoint handler — proxies defect detection requests
 * to the ViT inference sidecar service.
 *
 * Input:  POST /api/inspect { image: "<base64>" }
 * Output: { defectType, confidence, boundingBox, pass }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logError, logInfo } from "../logger.js";
import type { AuthRateLimiter } from "./auth/auth-rate-limit.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth/auth.js";
import {
  readJsonBodyOrError,
  sendGatewayAuthFailure,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

const INSPECT_PATH = "/api/inspect";
const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15MB (base64 overhead on 10MB image)
const PROXY_TIMEOUT_MS = 5_000;

type InspectRequestBody = {
  image?: unknown;
};

type InspectApiOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  rateLimiter?: AuthRateLimiter;
};

function getInspectServiceUrl(): string {
  return process.env.INSPECT_SERVICE_URL ?? "http://localhost:8100";
}

export async function handleInspectApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: InspectApiOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== INSPECT_PATH) {
    return false;
  }

  // Only POST allowed
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  // Auth check
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

  // Parse body
  const body = (await readJsonBodyOrError(req, res, MAX_BODY_BYTES)) as
    | InspectRequestBody
    | undefined;
  if (!body) {
    return true;
  } // Error already sent

  // Validate image field
  if (typeof body.image !== "string" || body.image.length === 0) {
    sendInvalidRequest(res, 'Missing or invalid "image" field (expected base64 string)');
    return true;
  }

  // Proxy to inference sidecar
  const serviceUrl = getInspectServiceUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const proxyRes = await fetch(`${serviceUrl}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: body.image }),
      signal: controller.signal,
    });

    if (!proxyRes.ok) {
      const errorText = await proxyRes.text().catch(() => "Unknown error");
      logError(`inspect-api: Sidecar returned ${proxyRes.status}: ${errorText}`);
      sendJson(res, proxyRes.status >= 500 ? 502 : proxyRes.status, {
        error: {
          message: `Inspection service error: ${errorText}`,
          type: "inspect_error",
        },
      });
      return true;
    }

    const result = await proxyRes.json();
    logInfo(`inspect-api: Inspection complete: ${result.defectType} (${result.confidence})`);
    sendJson(res, 200, result);
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Inspection service timeout"
        : "Inspection service unavailable";
    logError(`inspect-api: ${message}`);
    sendJson(res, 503, {
      error: { message, type: "inspect_unavailable" },
    });
  } finally {
    clearTimeout(timeout);
  }

  return true;
}
