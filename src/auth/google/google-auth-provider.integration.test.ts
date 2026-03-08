/**
 * Integration test for GoogleAuthProvider.
 * Uses a local HTTP mock server mimicking Google's token endpoint
 * to exercise the full provider flow end-to-end.
 */

import fs from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProvider, TokenResponse } from "../provider.js";
import { createGoogleAuthProvider } from "./google-auth-provider.js";

// ── Mock dependencies ────────────────────────────────────────────────

vi.mock("../../hooks/gog-credentials.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../hooks/gog-credentials.js")>();
  return {
    ...original,
    getGoogleClientId: () => "integration-client-id",
    getGoogleClientSecret: () => "integration-client-secret",
    syncToGogKeyring: vi.fn().mockResolvedValue({ success: true }),
  };
});

// ── Mock token server ────────────────────────────────────────────────

let mockServer: http.Server;
let mockPort: number;
let mockHandler: (body: URLSearchParams) => { status: number; body: string };

function startMockTokenServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        const params = new URLSearchParams(raw);
        const result = mockHandler(params);
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(result.body);
      });
    });
    mockServer.listen(0, "127.0.0.1", () => {
      const addr = mockServer.address();
      mockPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("GoogleAuthProvider integration", () => {
  let provider: AuthProvider;
  let tmpDir: string;
  let origFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    await startMockTokenServer();
    origFetch = globalThis.fetch;
  });

  afterAll(async () => {
    globalThis.fetch = origFetch;
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gauth-int-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
    provider = createGoogleAuthProvider();

    // Intercept fetch calls to Google token endpoint and redirect to mock server
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.href;
      } else {
        url = input.url;
      }
      if (url === "https://oauth2.googleapis.com/token") {
        const mockUrl = `http://127.0.0.1:${mockPort}/token`;
        return origFetch(mockUrl, init);
      }
      return origFetch(input, init);
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Full flow ────────────────────────────────────────────────────

  it("full flow: buildAuthUrl -> exchangeCode -> storeCredentials -> loadCredentials", async () => {
    // 1. Build auth URL
    const authUrl = provider.buildAuthUrl({
      email: "test@example.com",
      services: ["gmail", "drive"],
      redirectUri: "http://localhost:51234/oauth-callback",
      state: "integration-state-token",
    });

    const parsed = new URL(authUrl);
    expect(parsed.hostname).toBe("accounts.google.com");
    expect(parsed.searchParams.get("client_id")).toBe("integration-client-id");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("login_hint")).toBe("test@example.com");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:51234/oauth-callback");

    // Verify scopes include both gmail and drive
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("gmail");
    expect(scope).toContain("drive");

    // 2. Exchange code (mock server returns valid tokens)
    const mockTokens: TokenResponse = {
      access_token: "mock-access-token-xyz",
      refresh_token: "mock-refresh-token-abc",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      token_type: "Bearer",
    };
    mockHandler = (params) => {
      expect(params.get("code")).toBe("test-auth-code");
      expect(params.get("client_id")).toBe("integration-client-id");
      expect(params.get("client_secret")).toBe("integration-client-secret");
      expect(params.get("grant_type")).toBe("authorization_code");
      return { status: 200, body: JSON.stringify(mockTokens) };
    };

    const tokens = await provider.exchangeCode(
      "test-auth-code",
      "http://localhost:51234/oauth-callback",
    );
    expect(tokens.access_token).toBe("mock-access-token-xyz");
    expect(tokens.refresh_token).toBe("mock-refresh-token-abc");
    expect(tokens.expires_in).toBe(3600);

    // 3. Store credentials
    const credPath = await provider.storeCredentials({
      tokens,
      email: "test@example.com",
      services: ["gmail", "drive"],
      sessionKey: "sess-int",
      agentId: "agent-int",
    });

    expect(credPath).toContain("auth-credentials/google");
    const stored = JSON.parse(await fs.readFile(credPath, "utf-8"));
    expect(stored.email).toBe("test@example.com");
    expect(stored.accessToken).toBe("mock-access-token-xyz");
    expect(stored.refreshToken).toBe("mock-refresh-token-abc");
    expect(stored.services).toEqual(["gmail", "drive"]);

    // 4. Load credentials round-trip
    const loaded = await provider.loadCredentials("agent-int", "sess-int", "test@example.com");
    expect(loaded).not.toBeNull();
    expect(loaded!.email).toBe("test@example.com");
    expect(loaded!.accessToken).toBe("mock-access-token-xyz");
    expect(loaded!.refreshToken).toBe("mock-refresh-token-abc");
    expect(loaded!.services).toEqual(["gmail", "drive"]);
  });

  // ── URL backward compat ──────────────────────────────────────────

  it("URL format matches what gog-auth-start-tool previously produced", () => {
    const url = provider.buildAuthUrl({
      email: "user@gmail.com",
      services: ["gmail"],
      redirectUri: "http://localhost:51234/oauth-callback",
      state: "compat-state",
    });

    const parsed = new URL(url);
    // These exact params were hardcoded in the old gog-auth-start-tool.ts
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("response_type")).toBe("code");
  });

  // ── Error case ───────────────────────────────────────────────────

  it("exchangeCode throws on invalid grant (400 from server)", async () => {
    mockHandler = () => ({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant", error_description: "Code expired" }),
    });

    await expect(
      provider.exchangeCode("bad-code", "http://localhost:51234/oauth-callback"),
    ).rejects.toThrow(/Token exchange failed/);
  });
});
