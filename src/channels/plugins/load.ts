import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type { ChannelId, ChannelPlugin } from "./types.js";

const PLUGIN_CACHE_KEY = Symbol.for("minion.channelPluginCache");

type PluginCacheState = {
  cache: Map<ChannelId, ChannelPlugin>;
  lastRegistry: PluginRegistry | null;
};

const state: PluginCacheState = (() => {
  const g = globalThis as typeof globalThis & { [PLUGIN_CACHE_KEY]?: PluginCacheState };
  if (!g[PLUGIN_CACHE_KEY]) {
    g[PLUGIN_CACHE_KEY] = { cache: new Map(), lastRegistry: null };
  }
  return g[PLUGIN_CACHE_KEY];
})();

function ensureCacheForRegistry(registry: PluginRegistry | null) {
  if (registry === state.lastRegistry) {
    return;
  }
  state.cache.clear();
  state.lastRegistry = registry;
}

export async function loadChannelPlugin(id: ChannelId): Promise<ChannelPlugin | undefined> {
  const registry = getActivePluginRegistry();
  ensureCacheForRegistry(registry);
  const cached = state.cache.get(id);
  if (cached) {
    return cached;
  }
  const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
  if (pluginEntry) {
    state.cache.set(id, pluginEntry.plugin);
    return pluginEntry.plugin;
  }
  return undefined;
}
