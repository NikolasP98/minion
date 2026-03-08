import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../provider.js";
import { createGoogleAuthProvider, getProviderCredentialsDir } from "./google-auth-provider.js";

// Mock gog-credentials module
vi.mock("../../hooks/gog-credentials.js", () => ({
  getGoogleClientId: () => "test-client-id-123",
  getGoogleClientSecret: () => "test-client-secret-456",
  syncToGogKeyring: vi.fn().mockResolvedValue({ success: true }),
  getCredentialsDir: (agentId: string) =>
    path.join(os.homedir(), ".minion", "agents", agentId, "auth-credentials", "google"),
  getLegacyCredentialsDir: (agentId: string) =>
    path.join(os.homedir(), ".minion", "agents", agentId, "gog-credentials"),
  buildCredentialFilename: (sessionKey: string, email: string) => {
    const safeSessionKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, "_");
    return `${safeSessionKey}_${safeEmail}.json`;
  },
}));

describe("GoogleAuthProvider", () => {
  let provider: AuthProvider;

  beforeEach(() => {
    provider = createGoogleAuthProvider();
  });

  // ── Identity ─────────────────────────────────────────────────────

  it("has id 'google'", () => {
    expect(provider.id).toBe("google");
  });

  it("has displayName 'Google'", () => {
    expect(provider.displayName).toBe("Google");
  });

  // ── buildAuthUrl ─────────────────────────────────────────────────

  describe("buildAuthUrl", () => {
    it("produces a URL with correct host", () => {
      const url = provider.buildAuthUrl({
        email: "user@example.com",
        services: ["gmail"],
        redirectUri: "http://localhost:51234/oauth-callback",
        state: "test-state-token",
      });

      const parsed = new URL(url);
      expect(parsed.hostname).toBe("accounts.google.com");
    });

    it("includes client_id from getGoogleClientId", () => {
      const url = provider.buildAuthUrl({
        email: "user@example.com",
        services: ["gmail"],
        redirectUri: "http://localhost:51234/oauth-callback",
        state: "test-state-token",
      });

      const parsed = new URL(url);
      expect(parsed.searchParams.get("client_id")).toBe("test-client-id-123");
    });

    it("includes redirect_uri, response_type=code, state", () => {
      const url = provider.buildAuthUrl({
        email: "user@example.com",
        services: ["gmail"],
        redirectUri: "http://localhost:51234/oauth-callback",
        state: "abc123",
      });

      const parsed = new URL(url);
      expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:51234/oauth-callback");
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("state")).toBe("abc123");
    });

    it("sets access_type=offline and prompt=consent", () => {
      const url = provider.buildAuthUrl({
        email: "user@example.com",
        services: ["gmail"],
        redirectUri: "http://localhost:51234/oauth-callback",
        state: "test-state",
      });

      const parsed = new URL(url);
      expect(parsed.searchParams.get("access_type")).toBe("offline");
      expect(parsed.searchParams.get("prompt")).toBe("consent");
    });

    it("sets login_hint to email", () => {
      const url = provider.buildAuthUrl({
        email: "alice@gmail.com",
        services: ["gmail"],
        redirectUri: "http://localhost:51234/oauth-callback",
        state: "test-state",
      });

      const parsed = new URL(url);
      expect(parsed.searchParams.get("login_hint")).toBe("alice@gmail.com");
    });

    it("includes scopes for requested services", () => {
      const url = provider.buildAuthUrl({
        email: "user@example.com",
        services: ["gmail", "drive"],
        redirectUri: "http://localhost:51234/oauth-callback",
        state: "test-state",
      });

      const parsed = new URL(url);
      const scope = parsed.searchParams.get("scope") ?? "";
      expect(scope).toContain("gmail");
      expect(scope).toContain("drive");
    });
  });

  // ── getScopesForServices ─────────────────────────────────────────

  describe("getScopesForServices", () => {
    it("maps gmail to gmail scopes", () => {
      const scopes = provider.getScopesForServices(["gmail"]);
      expect(scopes.some((s) => s.includes("gmail"))).toBe(true);
      expect(scopes.length).toBeGreaterThan(0);
    });

    it("maps multiple services to union of scopes", () => {
      const scopes = provider.getScopesForServices(["gmail", "drive", "calendar"]);
      expect(scopes.some((s) => s.includes("gmail"))).toBe(true);
      expect(scopes.some((s) => s.includes("drive"))).toBe(true);
      expect(scopes.some((s) => s.includes("calendar"))).toBe(true);
    });

    it("ignores unknown service names without throwing", () => {
      const scopes = provider.getScopesForServices(["gmail", "unknown-service"]);
      expect(scopes.some((s) => s.includes("gmail"))).toBe(true);
      // Should not throw, just ignore unknown
    });
  });

  // ── getSupportedServices ─────────────────────────────────────────

  describe("getSupportedServices", () => {
    it("returns all 6 supported services", () => {
      const services = provider.getSupportedServices();
      expect(services).toContain("gmail");
      expect(services).toContain("calendar");
      expect(services).toContain("drive");
      expect(services).toContain("contacts");
      expect(services).toContain("docs");
      expect(services).toContain("sheets");
      expect(services).toHaveLength(6);
    });
  });

  // ── Credential paths ────────────────────────────────────────────

  describe("getProviderCredentialsDir", () => {
    it("returns path under auth-credentials/google/ (not gog-credentials/)", () => {
      const dir = getProviderCredentialsDir("agent-001");
      expect(dir).toContain("auth-credentials/google");
      expect(dir).not.toContain("gog-credentials");
      expect(dir).toContain("agent-001");
    });
  });

  // ── Credential storage and migration ────────────────────────────

  describe("credential storage and migration", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gauth-test-"));
      // Override homedir for tests
      vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("storeCredentials writes to auth-credentials/google/ path", async () => {
      const credPath = await provider.storeCredentials({
        tokens: {
          access_token: "access-tok",
          refresh_token: "refresh-tok",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          token_type: "Bearer",
        },
        email: "user@example.com",
        services: ["gmail"],
        sessionKey: "sess-1",
        agentId: "agent-001",
      });

      expect(credPath).toContain("auth-credentials/google");
      expect(credPath).not.toContain("gog-credentials");

      // Verify file was actually written
      const data = JSON.parse(await fs.readFile(credPath, "utf-8"));
      expect(data.email).toBe("user@example.com");
      expect(data.accessToken).toBe("access-tok");
      expect(data.refreshToken).toBe("refresh-tok");
      expect(data.services).toEqual(["gmail"]);
    });

    it("loadCredentials returns null when no credentials exist", async () => {
      const result = await provider.loadCredentials("agent-001", "sess-1", "user@example.com");
      expect(result).toBeNull();
    });

    it("loadCredentials finds credentials at new path", async () => {
      // Store first, then load
      await provider.storeCredentials({
        tokens: {
          access_token: "tok-1",
          refresh_token: "ref-1",
          expires_in: 3600,
          scope: "scope",
          token_type: "Bearer",
        },
        email: "user@example.com",
        services: ["gmail"],
        sessionKey: "sess-1",
        agentId: "agent-001",
      });

      const result = await provider.loadCredentials("agent-001", "sess-1", "user@example.com");
      expect(result).not.toBeNull();
      expect(result!.email).toBe("user@example.com");
      expect(result!.accessToken).toBe("tok-1");
    });

    it("loadCredentials migrates from gog-credentials/ to auth-credentials/google/", async () => {
      // Write a credential file at the OLD gog-credentials/ path
      const agentId = "agent-001";
      const sessionKey = "sess-1";
      const email = "migrate@example.com";
      const safeSession = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
      const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, "_");
      const filename = `${safeSession}_${safeEmail}.json`;

      const oldDir = path.join(tmpDir, ".minion", "agents", agentId, "gog-credentials");
      await fs.mkdir(oldDir, { recursive: true });
      const oldPath = path.join(oldDir, filename);

      const legacyCreds = {
        email,
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() + 3600_000,
        createdAt: Date.now(),
        sessionKey,
        agentId,
        services: ["gmail"],
      };
      await fs.writeFile(oldPath, JSON.stringify(legacyCreds), { mode: 0o600 });

      // Load should find old path, migrate, and return credentials
      const result = await provider.loadCredentials(agentId, sessionKey, email);
      expect(result).not.toBeNull();
      expect(result!.email).toBe(email);
      expect(result!.accessToken).toBe("old-access");

      // Verify: new path should exist
      const newDir = path.join(tmpDir, ".minion", "agents", agentId, "auth-credentials", "google");
      const newPath = path.join(newDir, filename);
      const newExists = await fs
        .access(newPath)
        .then(() => true)
        .catch(() => false);
      expect(newExists).toBe(true);

      // Verify: old path should be deleted
      const oldExists = await fs
        .access(oldPath)
        .then(() => true)
        .catch(() => false);
      expect(oldExists).toBe(false);
    });
  });
});
