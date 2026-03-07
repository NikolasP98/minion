import type { PluginRegistry } from "../../../plugins/registry.js";
import { getActivePluginRegistry } from "../../../plugins/runtime.js";
import type { ChannelId, ChannelOutboundAdapter } from "../types.js";

// Channel docking: outbound sends should stay cheap to import.
//
// The full channel plugins (src/channels/plugins/*.ts) pull in status,
// onboarding, gateway monitors, etc. Outbound delivery only needs chunking +
// send primitives, so we keep a dedicated, lightweight loader here.

const OUTBOUND_CACHE_KEY = Symbol.for("minion.channelOutboundCache");

type OutboundCacheState = {
  cache: Map<ChannelId, ChannelOutboundAdapter>;
  lastRegistry: PluginRegistry | null;
};

const state: OutboundCacheState = (() => {
  const g = globalThis as typeof globalThis & { [OUTBOUND_CACHE_KEY]?: OutboundCacheState };
  if (!g[OUTBOUND_CACHE_KEY]) {
    g[OUTBOUND_CACHE_KEY] = { cache: new Map(), lastRegistry: null };
  }
  return g[OUTBOUND_CACHE_KEY];
})();

function ensureCacheForRegistry(registry: PluginRegistry | null) {
  if (registry === state.lastRegistry) {
    return;
  }
  state.cache.clear();
  state.lastRegistry = registry;
}

export async function loadChannelOutboundAdapter(
  id: ChannelId,
): Promise<ChannelOutboundAdapter | undefined> {
  const registry = getActivePluginRegistry();
  ensureCacheForRegistry(registry);
  const cached = state.cache.get(id);
  if (cached) {
    return cached;
  }
  const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
  const outbound = pluginEntry?.plugin.outbound;
  if (outbound) {
    state.cache.set(id, outbound);
    return outbound;
  }
  return undefined;
}
