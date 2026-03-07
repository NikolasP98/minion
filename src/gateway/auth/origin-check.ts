import { isLoopbackHost, normalizeHostHeader, resolveHostName } from "../net.js";

type OriginCheckResult = { ok: true } | { ok: false; reason: string };

function parseOrigin(
  originRaw?: string,
): { origin: string; host: string; hostname: string } | null {
  const trimmed = (originRaw ?? "").trim();
  if (!trimmed || trimmed === "null") {
    return null;
  }
  try {
    const url = new URL(trimmed);
    return {
      origin: url.origin.toLowerCase(),
      host: url.host.toLowerCase(),
      hostname: url.hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

/**
 * Match an origin against a pattern that may contain a `*` wildcard for the port,
 * e.g. `http://localhost:*` matches `http://localhost:5173`.
 */
function matchesOriginPattern(pattern: string, origin: string): boolean {
  if (!pattern.includes("*")) {
    return pattern === origin;
  }
  const regex = new RegExp(
    "^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === "*" ? "\\d+" : "\\" + m)) + "$",
  );
  return regex.test(origin);
}

export function checkBrowserOrigin(params: {
  requestHost?: string;
  origin?: string;
  allowedOrigins?: string[];
}): OriginCheckResult {
  const parsedOrigin = parseOrigin(params.origin);
  if (!parsedOrigin) {
    return { ok: false, reason: "origin missing or invalid" };
  }

  const allowlist = (params.allowedOrigins ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.some((pattern) => matchesOriginPattern(pattern, parsedOrigin.origin))) {
    return { ok: true };
  }

  const requestHost = normalizeHostHeader(params.requestHost);
  if (requestHost && parsedOrigin.host === requestHost) {
    return { ok: true };
  }

  const requestHostname = resolveHostName(requestHost);
  if (isLoopbackHost(parsedOrigin.hostname) && isLoopbackHost(requestHostname)) {
    return { ok: true };
  }

  return { ok: false, reason: "origin not allowed" };
}
