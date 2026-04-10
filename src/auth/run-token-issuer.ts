/**
 * Run token issuer — creates JWT tokens with RFC 8693 `act` delegation chains
 * for agent runs, sub-agent delegation, and tool-scoped credentials.
 *
 * @module
 */

import {
  buildActClaim,
  signDelegationToken,
  TOOL_CREDENTIAL_TTL_SEC,
  type DelegationChain,
  type Principal,
} from "./delegation-token.js";

// ── Types ─────────────────────────────────────────────────────────────

/** Parameters for issuing a top-level agent run token. */
export type TopLevelRunTokenParams = {
  userId: string;
  tenantId: string;
  agentId: string;
};

/** Parameters for issuing a sub-agent delegation token. */
export type SubAgentRunTokenParams = {
  /** The parent agent's current delegation chain. */
  parentChain: DelegationChain;
  /** The child agent identity. */
  childAgentId: string;
  /** Optional role override (defaults to "agent"). */
  childRole?: string;
};

/** Parameters for issuing a tool-scoped credential. */
export type ToolCredentialParams = {
  /** The agent's current delegation chain. */
  agentChain: DelegationChain;
  /** Tool name being authorized. */
  toolName: string;
  /** Run ID for scoping. */
  runId: string;
};

/** Default TTL for agent run tokens (1 hour). */
const RUN_TOKEN_TTL_SEC = 60 * 60;

// ── Issuer ────────────────────────────────────────────────────────────

/**
 * RunTokenIssuer creates signed JWTs with nested `act` delegation chains.
 *
 * Usage:
 * ```ts
 * const issuer = new RunTokenIssuer(signingSecret);
 * const token = await issuer.issueTopLevelRunToken({ userId, tenantId, agentId });
 * ```
 */
export class RunTokenIssuer {
  private readonly secret: Uint8Array;

  constructor(secret: Uint8Array) {
    this.secret = secret;
  }

  /**
   * Issue a top-level run token for an agent acting on behalf of a user+tenant.
   *
   * Chain structure:
   * ```
   * { sub: "agent-{agentId}", role: "agent",
   *   act: { sub: "tenant-{tenantId}", role: "tenant",
   *     act: { sub: "user-{userId}", role: "user" } } }
   * ```
   */
  async issueTopLevelRunToken(
    params: TopLevelRunTokenParams,
  ): Promise<{ token: string; chain: DelegationChain }> {
    const now = Math.floor(Date.now() / 1000);

    // Build chain from innermost (user) outward
    const userLink: DelegationChain = {
      sub: `user-${params.userId}`,
      role: "user",
      iat: now,
    };

    const tenantLink = buildActClaim(userLink, {
      sub: `tenant-${params.tenantId}`,
      role: "tenant",
    });

    const agentLink = buildActClaim(tenantLink, {
      sub: `agent-${params.agentId}`,
      role: "agent",
    });

    const token = await signDelegationToken(agentLink, this.secret, RUN_TOKEN_TTL_SEC);

    return { token, chain: agentLink };
  }

  /**
   * Issue a delegation token for a sub-agent spawned by a parent agent.
   *
   * Extends the parent's chain by one level with the child agent identity.
   */
  async issueSubAgentRunToken(
    params: SubAgentRunTokenParams,
  ): Promise<{ token: string; chain: DelegationChain }> {
    const child: Principal = {
      sub: `agent-${params.childAgentId}`,
      role: params.childRole ?? "agent",
    };

    const chain = buildActClaim(params.parentChain, child);

    const token = await signDelegationToken(chain, this.secret, RUN_TOKEN_TTL_SEC);

    return { token, chain };
  }

  /**
   * Issue a short-lived tool-scoped credential (15-minute TTL).
   *
   * Scope format: `tool:{toolName}:run:{runId}`
   */
  async issueToolCredential(
    params: ToolCredentialParams,
  ): Promise<{ token: string; chain: DelegationChain }> {
    const scope = `tool:${params.toolName}:run:${params.runId}`;

    const child: Principal = {
      sub: `tool-${params.toolName}`,
      role: "tool",
      scope,
    };

    const chain = buildActClaim(params.agentChain, child);

    const token = await signDelegationToken(chain, this.secret, TOOL_CREDENTIAL_TTL_SEC);

    return { token, chain };
  }
}
