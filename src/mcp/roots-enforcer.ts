/**
 * RootsEnforcer — validates every `resources/read` and `resources/subscribe`
 * call against the per-connection root list, rejecting cross-tenant access.
 *
 * Each MCP connection is scoped to a tenant-specific root list at connect time:
 *   ["db://tenant-{id}/", "files:///workspaces/tenant-{id}/"]
 *
 * A resource URI is permitted if it starts with at least one of the roots.
 * The comparison is prefix-based (not glob) — roots MUST end with "/".
 */

/** A single root prefix, e.g. "db://tenant-abc/" */
export type ResourceRoot = string;

export type RootsEnforcerOptions = {
  roots: ResourceRoot[];
};

export type EnforceResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export class RootsEnforcer {
  private readonly roots: ResourceRoot[];

  constructor(opts: RootsEnforcerOptions) {
    if (opts.roots.length === 0) {
      throw new Error("RootsEnforcer requires at least one root");
    }
    // Normalise: roots must end with "/"
    this.roots = opts.roots.map((r) => (r.endsWith("/") ? r : `${r}/`));
  }

  /**
   * Returns { allowed: true } if the URI is within at least one root.
   * Returns { allowed: false, reason } otherwise.
   */
  check(uri: string): EnforceResult {
    for (const root of this.roots) {
      if (uri.startsWith(root) || uri === root.slice(0, -1)) {
        return { allowed: true };
      }
    }
    return {
      allowed: false,
      reason: `URI "${uri}" is outside the permitted roots for this connection`,
    };
  }

  /** Convenience: return all roots (for diagnostics). */
  getRoots(): ResourceRoot[] {
    return [...this.roots];
  }
}

/**
 * Build the default per-tenant root list for a given tenant ID.
 * tenantId should be a stable identifier (e.g. gateway instance key or auth scope).
 */
export function buildTenantRoots(tenantId: string): ResourceRoot[] {
  return [
    `db://tenant-${tenantId}/`,
    `files:///workspaces/tenant-${tenantId}/`,
  ];
}

/**
 * Wildcard roots — used when roots enforcement is disabled (e.g. loopback-only
 * deployments or when no tenant context is available).
 * Allows all db:// and files:/// URIs.
 */
export const OPEN_ROOTS: ResourceRoot[] = ["db://", "files:///"];
