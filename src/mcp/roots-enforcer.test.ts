import { describe, it, expect } from "vitest";
import { RootsEnforcer, buildTenantRoots, OPEN_ROOTS } from "./roots-enforcer.js";

describe("RootsEnforcer", () => {
  describe("check — allowed", () => {
    it("allows a URI that starts with a root", () => {
      const e = new RootsEnforcer({ roots: ["db://tenant-abc/"] });
      expect(e.check("db://tenant-abc/issues").allowed).toBe(true);
    });

    it("allows the root URI itself (without trailing slash)", () => {
      const e = new RootsEnforcer({ roots: ["db://tenant-abc/"] });
      expect(e.check("db://tenant-abc").allowed).toBe(true);
    });

    it("allows deep nested URIs", () => {
      const e = new RootsEnforcer({ roots: ["files:///workspaces/tenant-abc/"] });
      expect(e.check("files:///workspaces/tenant-abc/src/index.ts").allowed).toBe(true);
    });

    it("allows when one of multiple roots matches", () => {
      const e = new RootsEnforcer({ roots: buildTenantRoots("abc") });
      expect(e.check("db://tenant-abc/issues/123").allowed).toBe(true);
      expect(e.check("files:///workspaces/tenant-abc/main.ts").allowed).toBe(true);
    });
  });

  describe("check — blocked", () => {
    it("blocks URIs from a different tenant", () => {
      const e = new RootsEnforcer({ roots: ["db://tenant-abc/"] });
      const result = e.check("db://tenant-xyz/issues");
      expect(result.allowed).toBe(false);
      expect((result as { reason: string }).reason).toMatch(/outside/);
    });

    it("blocks URIs with a matching prefix but different tenant suffix", () => {
      // "db://tenant-abc-evil/" must not match "db://tenant-abc/"
      const e = new RootsEnforcer({ roots: ["db://tenant-abc/"] });
      expect(e.check("db://tenant-abc-evil/secrets").allowed).toBe(false);
    });

    it("blocks URIs from a completely different scheme", () => {
      const e = new RootsEnforcer({ roots: ["db://tenant-abc/"] });
      expect(e.check("files:///etc/passwd").allowed).toBe(false);
    });
  });

  describe("constructor", () => {
    it("throws when no roots provided", () => {
      expect(() => new RootsEnforcer({ roots: [] })).toThrow();
    });

    it("normalises roots that are missing trailing slash", () => {
      const e = new RootsEnforcer({ roots: ["db://tenant-abc"] });
      // Should still work — normalisation adds the slash internally
      expect(e.check("db://tenant-abc/issues").allowed).toBe(true);
    });
  });

  describe("OPEN_ROOTS", () => {
    it("allows all db:// and files:/// URIs", () => {
      const e = new RootsEnforcer({ roots: OPEN_ROOTS });
      expect(e.check("db://anything/123").allowed).toBe(true);
      expect(e.check("files:///workspaces/foo/bar.ts").allowed).toBe(true);
    });
  });

  describe("buildTenantRoots", () => {
    it("returns two roots for db:// and files:///", () => {
      const roots = buildTenantRoots("my-tenant");
      expect(roots).toHaveLength(2);
      expect(roots[0]).toBe("db://tenant-my-tenant/");
      expect(roots[1]).toBe("files:///workspaces/tenant-my-tenant/");
    });
  });
});
