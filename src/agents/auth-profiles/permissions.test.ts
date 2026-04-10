import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enforceAuthProfilePermissions } from "./permissions.js";
import { AUTH_PROFILE_FILENAME } from "./constants.js";

// Skip chmod tests on Windows (not applicable) and in CI where files may be
// owned by a different user (chmod succeeds only for the file owner).
const canChmod = process.platform !== "win32";

describe.skipIf(!canChmod)("enforceAuthProfilePermissions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-perms-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets directory to 0700", () => {
    // Start with a more permissive mode
    fs.chmodSync(tmpDir, 0o755);

    enforceAuthProfilePermissions(tmpDir);

    const stat = fs.statSync(tmpDir);
    // Only check the rwxrwxrwx bits (mask 0o777)
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("sets auth-profiles.json to 0600", () => {
    const profilesPath = path.join(tmpDir, AUTH_PROFILE_FILENAME);
    fs.writeFileSync(profilesPath, JSON.stringify({ version: 1, profiles: {} }), "utf8");
    // Start with a more permissive mode
    fs.chmodSync(profilesPath, 0o644);

    enforceAuthProfilePermissions(tmpDir);

    const stat = fs.statSync(profilesPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("does not fail if auth-profiles.json does not exist", () => {
    // No profiles file in directory — should not throw
    expect(() => enforceAuthProfilePermissions(tmpDir)).not.toThrow();
  });

  it("applies directory mode even when no profiles file exists", () => {
    fs.chmodSync(tmpDir, 0o755);
    enforceAuthProfilePermissions(tmpDir);
    const stat = fs.statSync(tmpDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});
