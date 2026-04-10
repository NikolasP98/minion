/**
 * Built-in plugin registrations.
 *
 * Called by the plugin loader after external plugins are registered, before
 * the global hook runner is initialized. Built-in plugins bypass the full
 * discovery/jiti-load cycle and push typed hook registrations directly into
 * the registry.
 */

import { createAuditPlugin } from "../audit/audit-plugin.js";
import { createAuditStore } from "../audit/audit-store.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginRegistry } from "./registry.js";

/**
 * Register all built-in plugins into the given registry.
 *
 * Each built-in is guarded by its corresponding config flag. When the flag
 * is absent or false the registration is a no-op, so there is zero overhead
 * unless the feature is explicitly enabled.
 */
export function registerBuiltinPlugins(
  registry: PluginRegistry,
  cfg: OpenClawConfig | undefined,
): void {
  if (cfg?.audit?.enabled) {
    const store = createAuditStore({
      dir: cfg.audit.dir,
      enabled: true,
    });

    const hooks = createAuditPlugin({
      store,
      complianceGate: cfg.audit.complianceGate ?? false,
    });

    for (const hook of hooks) {
      registry.typedHooks.push(hook);
    }
  }
}
