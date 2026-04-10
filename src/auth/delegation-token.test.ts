import { describe, expect, it } from "vitest";
import {
  buildActClaim,
  fingerprintChain,
  getDelegationDepth,
  parseDelegationChain,
  signDelegationToken,
  TOOL_CREDENTIAL_TTL_SEC,
  verifyDelegationToken,
  type DelegationChain,
  type DelegationJWTPayload,
} from "./delegation-token.js";
import { RunTokenIssuer } from "./run-token-issuer.js";

// ── Test secret (deterministic for tests) ─────────────────────────────
const TEST_SECRET = new TextEncoder().encode("test-secret-key-for-delegation-tokens-min-543");

// ── buildActClaim ─���──────────────────��────────────────────────────────

describe("buildActClaim", () => {
  it("nests a child under a parent", () => {
    const parent: DelegationChain = {
      sub: "user-alice",
      role: "user",
      iat: 1000,
    };

    const result = buildActClaim(parent, { sub: "tenant-acme", role: "tenant" });

    expect(result.sub).toBe("tenant-acme");
    expect(result.role).toBe("tenant");
    expect(result.act).toEqual(parent);
  });

  it("nests correctly to 3 levels", () => {
    const user: DelegationChain = { sub: "user-1", role: "user", iat: 1000 };
    const tenant = buildActClaim(user, { sub: "tenant-1", role: "tenant" });
    const agent = buildActClaim(tenant, { sub: "agent-1", role: "agent" });

    expect(agent.sub).toBe("agent-1");
    expect(agent.role).toBe("agent");
    expect(agent.act?.sub).toBe("tenant-1");
    expect(agent.act?.act?.sub).toBe("user-1");
    expect(getDelegationDepth(agent)).toBe(3);
  });

  it("preserves scope on child", () => {
    const parent: DelegationChain = { sub: "agent-1", role: "agent", iat: 1000 };
    const result = buildActClaim(parent, {
      sub: "tool-bash",
      role: "tool",
      scope: "tool:bash:run:abc-123",
    });

    expect(result.scope).toBe("tool:bash:run:abc-123");
    expect(result.act).toEqual(parent);
  });

  it("throws at max depth (10)", () => {
    let chain: DelegationChain = { sub: "root", role: "user", iat: 1000 };
    for (let i = 1; i < 10; i++) {
      chain = buildActClaim(chain, { sub: `level-${i}`, role: "agent" });
    }
    // Chain is now depth 10 — one more should fail
    expect(() => buildActClaim(chain, { sub: "overflow", role: "agent" })).toThrow(
      /exceed maximum of 10/,
    );
  });
});

// ── parseDelegationChain ─────────���────────────────────────────────────

describe("parseDelegationChain", () => {
  it("parses a flat JWT payload", () => {
    const payload: DelegationJWTPayload = {
      sub: "agent-1",
      role: "agent",
      iat: 1000,
    };

    const chain = parseDelegationChain(payload);
    expect(chain.sub).toBe("agent-1");
    expect(chain.role).toBe("agent");
    expect(chain.iat).toBe(1000);
    expect(chain.act).toBeUndefined();
  });

  it("round-trips a nested chain", () => {
    const user: DelegationChain = { sub: "user-1", role: "user", iat: 1000 };
    const tenant = buildActClaim(user, { sub: "tenant-1", role: "tenant" });
    const agent = buildActClaim(tenant, { sub: "agent-1", role: "agent" });

    // Simulate what would be in a JWT payload
    const payload: DelegationJWTPayload = {
      sub: agent.sub,
      role: agent.role,
      iat: agent.iat,
      act: agent.act,
    };

    const parsed = parseDelegationChain(payload);
    expect(parsed.sub).toBe("agent-1");
    expect(parsed.act?.sub).toBe("tenant-1");
    expect(parsed.act?.act?.sub).toBe("user-1");
  });

  it("throws when sub is missing", () => {
    expect(() =>
      parseDelegationChain({ role: "agent", iat: 1000 } as DelegationJWTPayload),
    ).toThrow(/missing required 'sub'/);
  });

  it("throws when role is missing", () => {
    expect(() =>
      parseDelegationChain({ sub: "agent-1", iat: 1000 } as DelegationJWTPayload),
    ).toThrow(/missing required 'role'/);
  });
});

// ── fingerprintChain ───────��───────────────────────────���──────────────

describe("fingerprintChain", () => {
  it("produces a hex string", () => {
    const chain: DelegationChain = { sub: "user-1", role: "user", iat: 1000 };
    const fp = fingerprintChain(chain);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic (same chain = same fingerprint)", () => {
    const chain: DelegationChain = { sub: "user-1", role: "user", iat: 1000 };
    expect(fingerprintChain(chain)).toBe(fingerprintChain(chain));
  });

  it("differs for different chains", () => {
    const a: DelegationChain = { sub: "user-1", role: "user", iat: 1000 };
    const b: DelegationChain = { sub: "user-2", role: "user", iat: 1000 };
    expect(fingerprintChain(a)).not.toBe(fingerprintChain(b));
  });
});

// ── Sign / Verify round-trip ────────���─────────────────────────────────

describe("signDelegationToken / verifyDelegationToken", () => {
  it("round-trips a signed delegation token", async () => {
    const user: DelegationChain = {
      sub: "user-1",
      role: "user",
      iat: Math.floor(Date.now() / 1000),
    };
    const tenant = buildActClaim(user, { sub: "tenant-1", role: "tenant" });
    const agent = buildActClaim(tenant, { sub: "agent-1", role: "agent" });

    const token = await signDelegationToken(agent, TEST_SECRET, 3600);
    const parsed = await verifyDelegationToken(token, TEST_SECRET);

    expect(parsed.sub).toBe("agent-1");
    expect(parsed.role).toBe("agent");
    expect(parsed.act?.sub).toBe("tenant-1");
    expect(parsed.act?.act?.sub).toBe("user-1");
  });

  it("rejects token signed with wrong secret", async () => {
    const chain: DelegationChain = {
      sub: "agent-1",
      role: "agent",
      iat: Math.floor(Date.now() / 1000),
    };
    const token = await signDelegationToken(chain, TEST_SECRET, 3600);
    const wrongSecret = new TextEncoder().encode("wrong-secret");

    await expect(verifyDelegationToken(token, wrongSecret)).rejects.toThrow();
  });
});

// ── RunTokenIssuer ──────���─────────────────────────────────────────────

describe("RunTokenIssuer", () => {
  const issuer = new RunTokenIssuer(TEST_SECRET);

  it("issues a top-level run token with correct chain structure", async () => {
    const { token, chain } = await issuer.issueTopLevelRunToken({
      userId: "alice",
      tenantId: "acme",
      agentId: "bot-1",
    });

    expect(token).toBeTruthy();
    expect(chain.sub).toBe("agent-bot-1");
    expect(chain.role).toBe("agent");
    expect(chain.act?.sub).toBe("tenant-acme");
    expect(chain.act?.role).toBe("tenant");
    expect(chain.act?.act?.sub).toBe("user-alice");
    expect(chain.act?.act?.role).toBe("user");

    // Verify the token decodes back correctly
    const parsed = await verifyDelegationToken(token, TEST_SECRET);
    expect(parsed.sub).toBe("agent-bot-1");
    expect(parsed.act?.act?.sub).toBe("user-alice");
  });

  it("issues a sub-agent delegation token extending parent chain", async () => {
    const { chain: parentChain } = await issuer.issueTopLevelRunToken({
      userId: "alice",
      tenantId: "acme",
      agentId: "parent-bot",
    });

    const { token, chain } = await issuer.issueSubAgentRunToken({
      parentChain,
      childAgentId: "child-bot",
    });

    expect(token).toBeTruthy();
    expect(chain.sub).toBe("agent-child-bot");
    expect(chain.act?.sub).toBe("agent-parent-bot");
    expect(getDelegationDepth(chain)).toBe(4); // child -> parent -> tenant -> user
  });

  it("issues a tool-scoped credential with 15-min TTL scope", async () => {
    const { chain: agentChain } = await issuer.issueTopLevelRunToken({
      userId: "alice",
      tenantId: "acme",
      agentId: "bot-1",
    });

    const { token, chain } = await issuer.issueToolCredential({
      agentChain,
      toolName: "bash",
      runId: "run-abc-123",
    });

    expect(token).toBeTruthy();
    expect(chain.sub).toBe("tool-bash");
    expect(chain.role).toBe("tool");
    expect(chain.scope).toBe("tool:bash:run:run-abc-123");
    expect(getDelegationDepth(chain)).toBe(4); // tool -> agent -> tenant -> user
  });

  it("TOOL_CREDENTIAL_TTL_SEC is 15 minutes", () => {
    expect(TOOL_CREDENTIAL_TTL_SEC).toBe(15 * 60);
  });
});
