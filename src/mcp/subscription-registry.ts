/**
 * SubscriptionRegistry — maps resource URIs to the set of connection IDs that
 * have subscribed, and manages the lifecycle of per-URI ResourceWatchers.
 */

export type ResourceChangeType = "updated" | "deleted";

export type ResourceChangeHandler = (changeType: ResourceChangeType) => void;

/**
 * A ResourceWatcher monitors one resource URI for changes and calls the
 * provided handler when the resource changes.
 */
export interface ResourceWatcher {
  /** Called by the registry when the first subscriber arrives for this URI. */
  start(onChange: ResourceChangeHandler): void;
  /** Called by the registry when the last subscriber leaves. Clean up listeners. */
  stop(): void;
}

export type ResourceWatcherFactory = (uri: string) => ResourceWatcher | null;

/**
 * SendNotificationFn sends a `notifications/resources/updated` JSON-RPC
 * notification to a specific MCP connection.
 */
export type SendNotificationFn = (connId: string, uri: string, changeType: ResourceChangeType) => void;

export type SubscriptionRegistryOptions = {
  /** Factory that creates a watcher for a given URI, or returns null if not watchable. */
  watcherFactory: ResourceWatcherFactory;
  /** Max subscriptions per connection (prevents runaway subscription loops). */
  maxPerConnection?: number;
};

type ConnSub = {
  uris: Set<string>;
};

export type SubscriptionRegistry = {
  subscribe: (connId: string, uri: string, send: SendNotificationFn) => { ok: boolean; error?: string };
  unsubscribe: (connId: string, uri: string) => void;
  unsubscribeAll: (connId: string) => void;
  activeUriCount: () => number;
  activeConnCount: () => number;
};

const DEFAULT_MAX_PER_CONNECTION = 100;

export function createSubscriptionRegistry(opts: SubscriptionRegistryOptions): SubscriptionRegistry {
  const { watcherFactory, maxPerConnection = DEFAULT_MAX_PER_CONNECTION } = opts;

  /** uri → Set<connId> */
  const uriSubscribers = new Map<string, Set<string>>();
  /** uri → active watcher */
  const watchers = new Map<string, ResourceWatcher>();
  /** connId → connection subscription state */
  const connState = new Map<string, ConnSub>();

  const ensureConnState = (connId: string): ConnSub => {
    let state = connState.get(connId);
    if (!state) {
      state = { uris: new Set() };
      connState.set(connId, state);
    }
    return state;
  };

  const startWatcher = (uri: string, send: SendNotificationFn): void => {
    if (watchers.has(uri)) {
      return;
    }
    const watcher = watcherFactory(uri);
    if (!watcher) {
      return;
    }
    watcher.start((changeType) => {
      const subs = uriSubscribers.get(uri);
      if (!subs || subs.size === 0) {
        return;
      }
      for (const cid of subs) {
        send(cid, uri, changeType);
      }
    });
    watchers.set(uri, watcher);
  };

  const stopWatcherIfUnused = (uri: string): void => {
    const subs = uriSubscribers.get(uri);
    if (!subs || subs.size === 0) {
      uriSubscribers.delete(uri);
      const watcher = watchers.get(uri);
      if (watcher) {
        watcher.stop();
        watchers.delete(uri);
      }
    }
  };

  const subscribe = (
    connId: string,
    uri: string,
    send: SendNotificationFn,
  ): { ok: boolean; error?: string } => {
    const state = ensureConnState(connId);

    if (state.uris.has(uri)) {
      // Already subscribed — idempotent, report success.
      return { ok: true };
    }

    if (state.uris.size >= maxPerConnection) {
      return {
        ok: false,
        error: `subscription limit reached (max ${maxPerConnection} per connection)`,
      };
    }

    let subs = uriSubscribers.get(uri);
    if (!subs) {
      subs = new Set();
      uriSubscribers.set(uri, subs);
    }
    subs.add(connId);
    state.uris.add(uri);

    startWatcher(uri, send);

    return { ok: true };
  };

  const unsubscribe = (connId: string, uri: string): void => {
    const state = connState.get(connId);
    if (!state || !state.uris.has(uri)) {
      return;
    }
    state.uris.delete(uri);
    if (state.uris.size === 0) {
      connState.delete(connId);
    }

    const subs = uriSubscribers.get(uri);
    if (subs) {
      subs.delete(connId);
    }
    stopWatcherIfUnused(uri);
  };

  const unsubscribeAll = (connId: string): void => {
    const state = connState.get(connId);
    if (!state) {
      return;
    }
    for (const uri of state.uris) {
      const subs = uriSubscribers.get(uri);
      if (subs) {
        subs.delete(connId);
      }
      stopWatcherIfUnused(uri);
    }
    connState.delete(connId);
  };

  const activeUriCount = (): number => uriSubscribers.size;
  const activeConnCount = (): number => connState.size;

  return { subscribe, unsubscribe, unsubscribeAll, activeUriCount, activeConnCount };
}
