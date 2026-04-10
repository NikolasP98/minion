import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSubscriptionRegistry } from "./subscription-registry.js";
import type { ResourceWatcher, ResourceChangeHandler, ResourceWatcherFactory } from "./subscription-registry.js";

// ---------------------------------------------------------------------------
// Test watcher that exposes its onChange callback
// ---------------------------------------------------------------------------

function makeFakeWatcher(): ResourceWatcher & { trigger: (changeType?: "updated" | "deleted") => void } {
  let storedHandler: ResourceChangeHandler | null = null;
  return {
    start(onChange) {
      storedHandler = onChange;
    },
    stop() {
      storedHandler = null;
    },
    trigger(changeType = "updated") {
      storedHandler?.(changeType);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(maxPerConnection?: number) {
  const watchers = new Map<string, ReturnType<typeof makeFakeWatcher>>();
  const factory: ResourceWatcherFactory = (uri) => {
    const w = makeFakeWatcher();
    watchers.set(uri, w);
    return w;
  };
  const registry = createSubscriptionRegistry({ watcherFactory: factory, maxPerConnection });
  return { registry, watchers };
}

function noop() {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubscriptionRegistry", () => {
  describe("subscribe", () => {
    it("allows a connection to subscribe to a URI", () => {
      const { registry } = makeRegistry();
      const result = registry.subscribe("conn1", "db://issues/assigned", noop);
      expect(result.ok).toBe(true);
    });

    it("starts a watcher on first subscriber", () => {
      const { registry, watchers } = makeRegistry();
      registry.subscribe("conn1", "db://issues/assigned", noop);
      expect(watchers.has("db://issues/assigned")).toBe(true);
    });

    it("does not start a second watcher for the same URI", () => {
      const { registry, watchers } = makeRegistry();
      registry.subscribe("conn1", "db://issues/assigned", noop);
      registry.subscribe("conn2", "db://issues/assigned", noop);
      expect(watchers.size).toBe(1);
    });

    it("is idempotent for the same conn/URI pair", () => {
      const { registry } = makeRegistry();
      const r1 = registry.subscribe("conn1", "db://issues/assigned", noop);
      const r2 = registry.subscribe("conn1", "db://issues/assigned", noop);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      // Only 1 subscription should be tracked
      expect(registry.activeConnCount()).toBe(1);
    });

    it("rejects when maxPerConnection is exceeded", () => {
      const { registry } = makeRegistry(2);
      registry.subscribe("conn1", "db://a", noop);
      registry.subscribe("conn1", "db://b", noop);
      const r = registry.subscribe("conn1", "db://c", noop);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/limit/);
    });

    it("returns null-watcher URIs as ok (no watcher started)", () => {
      const factory: ResourceWatcherFactory = () => null;
      const registry = createSubscriptionRegistry({ watcherFactory: factory });
      const r = registry.subscribe("conn1", "unknown://x", noop);
      expect(r.ok).toBe(true);
    });
  });

  describe("notifications", () => {
    it("notifies subscribed connections when watcher triggers", () => {
      const { registry, watchers } = makeRegistry();
      const received: Array<{ connId: string; uri: string; changeType: string }> = [];
      const send = (connId: string, uri: string, changeType: string) =>
        received.push({ connId, uri, changeType });

      registry.subscribe("conn1", "db://issues/assigned", send);
      watchers.get("db://issues/assigned")!.trigger("updated");

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ connId: "conn1", uri: "db://issues/assigned", changeType: "updated" });
    });

    it("notifies all subscribers of the same URI", () => {
      const { registry, watchers } = makeRegistry();
      const received: string[] = [];
      const send = (connId: string) => received.push(connId);

      registry.subscribe("conn1", "db://issues/assigned", send);
      registry.subscribe("conn2", "db://issues/assigned", send);
      watchers.get("db://issues/assigned")!.trigger();

      expect(received).toContain("conn1");
      expect(received).toContain("conn2");
    });
  });

  describe("unsubscribe", () => {
    it("stops the watcher when the last subscriber unsubscribes", () => {
      const { registry, watchers } = makeRegistry();
      registry.subscribe("conn1", "db://issues/assigned", noop);
      registry.unsubscribe("conn1", "db://issues/assigned");

      const watcher = watchers.get("db://issues/assigned");
      // After stop(), storedHandler is null — trigger should be no-op
      expect(() => watcher!.trigger()).not.toThrow();
      expect(registry.activeConnCount()).toBe(0);
    });

    it("keeps watcher alive if other subscribers remain", () => {
      const { registry, watchers } = makeRegistry();
      const received: string[] = [];
      const send = (connId: string) => received.push(connId);

      registry.subscribe("conn1", "db://issues/assigned", send);
      registry.subscribe("conn2", "db://issues/assigned", send);
      registry.unsubscribe("conn1", "db://issues/assigned");
      watchers.get("db://issues/assigned")!.trigger();

      expect(received).toContain("conn2");
      expect(received).not.toContain("conn1");
    });
  });

  describe("unsubscribeAll", () => {
    it("removes all subscriptions for a connection", () => {
      const { registry } = makeRegistry();
      registry.subscribe("conn1", "db://a", noop);
      registry.subscribe("conn1", "db://b", noop);
      registry.subscribe("conn2", "db://a", noop);

      registry.unsubscribeAll("conn1");

      expect(registry.activeConnCount()).toBe(1);
      expect(registry.activeUriCount()).toBe(1);
    });
  });

  describe("activeUriCount / activeConnCount", () => {
    it("tracks counts correctly across subscribe/unsubscribe", () => {
      const { registry } = makeRegistry();
      expect(registry.activeUriCount()).toBe(0);
      expect(registry.activeConnCount()).toBe(0);

      registry.subscribe("conn1", "db://a", noop);
      expect(registry.activeUriCount()).toBe(1);
      expect(registry.activeConnCount()).toBe(1);

      registry.subscribe("conn2", "db://a", noop);
      expect(registry.activeUriCount()).toBe(1);
      expect(registry.activeConnCount()).toBe(2);

      registry.subscribe("conn1", "db://b", noop);
      expect(registry.activeUriCount()).toBe(2);

      registry.unsubscribeAll("conn1");
      expect(registry.activeConnCount()).toBe(1);
    });
  });
});
