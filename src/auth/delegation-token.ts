/**
 * RFC 8693 `act` claim delegation chain utilities.
 *
 * Provides types and functions for building, parsing, and fingerprinting
 * nested delegation chains in JWT tokens used for agent run authorization.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum nesting depth for delegation chains (prevents infinite recursion). */
const MAX_DELEGATION_DEPTH = 10;

/** TTL for tool-scoped credentials (15 minutes in seconds). */
export const TOOL_CREDENTIAL_TTL_SEC = 15 * 60;

// ── Types ─────────────────────────────────────────────────────────────

/** A single link in the RFC 8693 `act` delegation chain. */
export type DelegationChain = {
  /** Subject identifier (e.g. "user-abc", "tenant-xyz", "agent-123"). */
  sub: string;
  /** Role of this principal (e.g. "user", "tenant", "agent", "tool"). */
  role: string;
  /** Issued-at timestamp (epoch seconds). */
  iat: number;
  /** Optional scope restriction (e.g. "tool:bash:run:abc-123"). */
  scope?: string;
  /** Nested actor — the principal that delegated to this one. */
  act?: DelegationChain;
};

/** Principal identity used when extending a chain. */
export type Principal = {
  sub: string;
  role: string;
  scope?: string;
};

/** JWT payload shape that includes the `act` delegation claim. */
export type DelegationJWTPayload = JWTPayload & {
  act?: DelegationChain;
  role?: string;
  scope?: string;
};

// ── Chain utilities ───────────────────────────────────────────────────

/**
 * Count the nesting depth of a delegation chain.
 * Returns 1 for a single link, 2 for one level of nesting, etc.
 */
function chainDepth(chain: DelegationChain): number {
  let depth = 1;
  let current = chain.act;
  while (current) {
    depth++;
    current = current.act;
  }
  return depth;
}

/**
 * Build an `act` claim by nesting a child principal under a parent chain.
 *
 * The child becomes the new top-level subject and the parent chain is
 * pushed into the `act` field, representing "child acting on behalf of parent".
 *
 * @throws Error if the resulting chain exceeds MAX_DELEGATION_DEPTH (10).
 */
export function buildActClaim(parent: DelegationChain, child: Principal): DelegationChain {
  const parentDepth = chainDepth(parent);
  if (parentDepth >= MAX_DELEGATION_DEPTH) {
    throw new Error(`Delegation chain depth would exceed maximum of ${MAX_DELEGATION_DEPTH}`);
  }

  const result: DelegationChain = {
    sub: child.sub,
    role: child.role,
    iat: Math.floor(Date.now() / 1000),
    act: parent,
  };
  if (child.scope) {
    result.scope = child.scope;
  }
  return result;
}

/**
 * Parse a delegation chain from a decoded JWT payload.
 *
 * Extracts the top-level subject + role and recursively parses
 * the nested `act` claim. Enforces MAX_DELEGATION_DEPTH.
 *
 * @throws Error if the payload is missing required fields or exceeds depth.
 */
export function parseDelegationChain(payload: DelegationJWTPayload): DelegationChain {
  if (!payload.sub) {
    throw new Error("JWT payload missing required 'sub' claim");
  }
  if (!payload.role) {
    throw new Error("JWT payload missing required 'role' claim");
  }
  if (typeof payload.iat !== "number") {
    throw new Error("JWT payload missing required 'iat' claim");
  }

  function parseAct(raw: Record<string, unknown>, depth: number): DelegationChain {
    if (depth > MAX_DELEGATION_DEPTH) {
      throw new Error(`Delegation chain depth exceeds maximum of ${MAX_DELEGATION_DEPTH}`);
    }
    if (typeof raw.sub !== "string" || typeof raw.role !== "string") {
      throw new Error("Act claim missing required 'sub' or 'role'");
    }
    const chain: DelegationChain = {
      sub: raw.sub,
      role: raw.role,
      iat: typeof raw.iat === "number" ? raw.iat : Math.floor(Date.now() / 1000),
    };
    if (typeof raw.scope === "string") {
      chain.scope = raw.scope;
    }
    if (raw.act && typeof raw.act === "object") {
      chain.act = parseAct(raw.act as Record<string, unknown>, depth + 1);
    }
    return chain;
  }

  const chain: DelegationChain = {
    sub: payload.sub,
    role: payload.role,
    iat: payload.iat,
  };
  if (typeof payload.scope === "string") {
    chain.scope = payload.scope;
  }
  if (payload.act && typeof payload.act === "object") {
    chain.act = parseAct(payload.act as Record<string, unknown>, 2);
  }
  return chain;
}

/**
 * Produce a deterministic SHA-256 fingerprint of a delegation chain.
 *
 * Uses sorted-key JSON serialization so the fingerprint is stable
 * regardless of property insertion order.
 */
export function fingerprintChain(chain: DelegationChain): string {
  const canonical = JSON.stringify(chain, Object.keys(chain).toSorted());
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Return the depth (number of principals) in a delegation chain.
 */
export function getDelegationDepth(chain: DelegationChain): number {
  return chainDepth(chain);
}

// ── JWT sign / verify helpers ─────────────────────────────────────────

/**
 * Sign a delegation JWT with the given secret.
 *
 * @param chain  The delegation chain (becomes the top-level subject + act claims)
 * @param secret The HMAC secret (Uint8Array or string encoded to UTF-8)
 * @param ttlSec Token TTL in seconds
 */
export async function signDelegationToken(
  chain: DelegationChain,
  secret: Uint8Array,
  ttlSec: number,
): Promise<string> {
  const payload: Record<string, unknown> = {
    role: chain.role,
  };
  if (chain.scope) {
    payload.scope = chain.scope;
  }
  if (chain.act) {
    payload.act = chain.act;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(chain.sub)
    .setIssuedAt(chain.iat)
    .setExpirationTime(chain.iat + ttlSec)
    .setIssuer("minion-gateway")
    .sign(secret);
}

/**
 * Verify and decode a delegation JWT, returning the parsed chain.
 *
 * @throws On invalid/expired token or malformed chain.
 */
export async function verifyDelegationToken(
  token: string,
  secret: Uint8Array,
): Promise<DelegationChain> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: "minion-gateway",
    algorithms: ["HS256"],
  });
  return parseDelegationChain(payload as DelegationJWTPayload);
}
