import fsSync from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { importTokensToGogKeyring } from "./gog-credentials.js";
import type { GogCredentials } from "./gog-oauth-types.js";

const runCommandWithTimeoutMock = vi.fn();

vi.mock("../platform/process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

describe("importTokensToGogKeyring", () => {
  it("writes email field to temp token JSON file", async () => {
    const credentials: GogCredentials = {
      email: "test@example.com",
      accessToken: "access-token-123",
      refreshToken: "refresh-token-456",
      expiresAt: Date.now() + 3600 * 1000,
      agentId: "test-agent",
      sessionKey: "session-key",
    };

    runCommandWithTimeoutMock.mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
    });

    const writeFileSpy = vi.spyOn(fsSync, "writeFileSync");

    await importTokensToGogKeyring(credentials);

    const tokenFileCall = writeFileSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("gog-token-import-"),
    );
    expect(
      tokenFileCall,
      "writeFileSync must be called with a gog-token-import-* path",
    ).toBeDefined();

    const writtenJson = JSON.parse(tokenFileCall![1] as string) as Record<string, unknown>;
    expect(writtenJson.email).toBe("test@example.com");
    expect(writtenJson.access_token).toBe("access-token-123");
    expect(writtenJson.refresh_token).toBe("refresh-token-456");
    expect(writtenJson.token_type).toBe("Bearer");
    expect(writtenJson.expiry).toBeDefined();
  });

  it("passes --account flag with credentials email to gog auth tokens import", async () => {
    const credentials: GogCredentials = {
      email: "admin@example.com",
      accessToken: "tok",
      refreshToken: "rtok",
      expiresAt: Date.now() + 3600 * 1000,
      agentId: "ceo",
      sessionKey: "main",
    };

    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
    });

    await importTokensToGogKeyring(credentials);

    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        "gog",
        "auth",
        "tokens",
        "import",
        expect.stringContaining("gog-token-import-"),
        "--account",
        "admin@example.com",
      ]),
      expect.anything(),
    );
  });

  it("returns failure result when gog exits non-zero", async () => {
    const credentials: GogCredentials = {
      email: "test@example.com",
      accessToken: "tok",
      refreshToken: "rtok",
      expiresAt: Date.now() + 3600 * 1000,
      agentId: "agent",
      sessionKey: "key",
    };

    runCommandWithTimeoutMock.mockResolvedValue({
      code: 2,
      stdout: "",
      stderr: "missing email in token file",
      signal: null,
      killed: false,
    });

    const result = await importTokensToGogKeyring(credentials);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exit code 2/);
  });
});
