import { onAgentEvent } from "../../infra/agent-events.js";
import {
  getRedisClient,
  getRedisSubscriber,
  mkKey,
  rDeserialise,
  rSerialise,
} from "../../infra/redis.js";

const AGENT_RUN_CACHE_TTL_MS = 10 * 60_000;
const AGENT_RUN_CACHE_TTL_SECS = Math.ceil(AGENT_RUN_CACHE_TTL_MS / 1000);
/**
 * Embedded runs can emit transient lifecycle `error` events while auth/model
 * failover is still in progress. Give errors a short grace window so a
 * subsequent `start` event can cancel premature terminal snapshots.
 */
const AGENT_RUN_ERROR_RETRY_GRACE_MS = 15_000;

const agentRunCache = new Map<string, AgentRunSnapshot>();
const agentRunStarts = new Map<string, number>();
const pendingAgentRunErrors = new Map<string, PendingAgentRunError>();
let agentRunListenerStarted = false;

type AgentRunSnapshot = {
  runId: string;
  status: "ok" | "error" | "timeout";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  ts: number;
};

type PendingAgentRunError = {
  snapshot: AgentRunSnapshot;
  dueAt: number;
  timer: NodeJS.Timeout;
};

type LifecycleMessage = {
  runId: string;
  phase: "start" | "end" | "error";
  snapshot?: AgentRunSnapshot;
};

// ── Redis key constants ────────────────────────────────────────────────────
const LIFECYCLE_CHANNEL = mkKey("agent", "lifecycle");

// ── Redis helpers (all fire-and-forget safe) ───────────────────────────────
async function redisGetSnapshot(runId: string): Promise<AgentRunSnapshot | null> {
  const rc = getRedisClient();
  if (!rc) return null;
  const raw = await rc.get(mkKey("agent", "run", runId));
  return rDeserialise<AgentRunSnapshot>(raw);
}

function redisBgSetSnapshot(snapshot: AgentRunSnapshot): void {
  const rc = getRedisClient();
  if (!rc) return;
  rc.set(
    mkKey("agent", "run", snapshot.runId),
    rSerialise(snapshot),
    "EX",
    AGENT_RUN_CACHE_TTL_SECS,
  ).catch(() => {});
}

function redisBgDeleteSnapshot(runId: string): void {
  const rc = getRedisClient();
  if (!rc) return;
  rc.del(mkKey("agent", "run", runId)).catch(() => {});
}

function redisBgSetStart(runId: string, ts: number): void {
  const rc = getRedisClient();
  if (!rc) return;
  rc.set(mkKey("agent", "start", runId), String(ts), "EX", AGENT_RUN_CACHE_TTL_SECS).catch(
    () => {},
  );
}

function redisBgDeleteStart(runId: string): void {
  const rc = getRedisClient();
  if (!rc) return;
  rc.del(mkKey("agent", "start", runId)).catch(() => {});
}

function redisBgPublishLifecycle(msg: LifecycleMessage): void {
  const rc = getRedisClient();
  if (!rc) return;
  rc.publish(LIFECYCLE_CHANNEL, rSerialise(msg)).catch(() => {});
}

// ── In-memory cache helpers ────────────────────────────────────────────────
function pruneAgentRunCache(now = Date.now()) {
  for (const [runId, entry] of agentRunCache) {
    if (now - entry.ts > AGENT_RUN_CACHE_TTL_MS) {
      agentRunCache.delete(runId);
    }
  }
}

function recordAgentRunSnapshot(entry: AgentRunSnapshot) {
  pruneAgentRunCache(entry.ts);
  agentRunCache.set(entry.runId, entry);
}

function clearPendingAgentRunError(runId: string) {
  const pending = pendingAgentRunErrors.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingAgentRunErrors.delete(runId);
}

function schedulePendingAgentRunError(snapshot: AgentRunSnapshot) {
  clearPendingAgentRunError(snapshot.runId);
  const dueAt = Date.now() + AGENT_RUN_ERROR_RETRY_GRACE_MS;
  const timer = setTimeout(() => {
    const pending = pendingAgentRunErrors.get(snapshot.runId);
    if (!pending) {
      return;
    }
    pendingAgentRunErrors.delete(snapshot.runId);
    recordAgentRunSnapshot(pending.snapshot);
  }, AGENT_RUN_ERROR_RETRY_GRACE_MS);
  timer.unref?.();
  pendingAgentRunErrors.set(snapshot.runId, { snapshot, dueAt, timer });
}

function getPendingAgentRunError(runId: string) {
  const pending = pendingAgentRunErrors.get(runId);
  if (!pending) {
    return undefined;
  }
  return {
    snapshot: pending.snapshot,
    dueAt: pending.dueAt,
  };
}

function createSnapshotFromLifecycleEvent(params: {
  runId: string;
  phase: "end" | "error";
  data?: Record<string, unknown>;
}): AgentRunSnapshot {
  const { runId, phase, data } = params;
  const startedAt =
    typeof data?.startedAt === "number" ? data.startedAt : agentRunStarts.get(runId);
  const endedAt = typeof data?.endedAt === "number" ? data.endedAt : undefined;
  const error = typeof data?.error === "string" ? data.error : undefined;
  return {
    runId,
    status: phase === "error" ? "error" : data?.aborted ? "timeout" : "ok",
    startedAt,
    endedAt,
    error,
    ts: Date.now(),
  };
}

function getCachedAgentRun(runId: string) {
  pruneAgentRunCache();
  return agentRunCache.get(runId);
}

// ── Lifecycle event listener ───────────────────────────────────────────────
// Kept SYNCHRONOUS so local cache is always up-to-date when per-request
// listeners run. Redis operations are fire-and-forget to avoid async delays
// that would cause per-request listeners to miss the cache write.
function ensureAgentRunListener() {
  if (agentRunListenerStarted) {
    return;
  }
  agentRunListenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt) {
      return;
    }
    if (evt.stream !== "lifecycle") {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      const ts = startedAt ?? Date.now();
      agentRunStarts.set(evt.runId, ts);
      clearPendingAgentRunError(evt.runId);
      // A new start means this run is active again (or retried). Drop stale
      // terminal snapshots so waiters don't resolve from old state.
      agentRunCache.delete(evt.runId);
      // Background Redis sync
      redisBgSetStart(evt.runId, ts);
      redisBgDeleteSnapshot(evt.runId);
      redisBgPublishLifecycle({ runId: evt.runId, phase: "start" });
      return;
    }
    if (phase !== "end" && phase !== "error") {
      return;
    }
    const snapshot = createSnapshotFromLifecycleEvent({
      runId: evt.runId,
      phase,
      data: evt.data,
    });
    agentRunStarts.delete(evt.runId);
    if (phase === "error") {
      schedulePendingAgentRunError(snapshot);
      // Defer Redis write — grace period may cancel it (if a "start" follows)
      setTimeout(() => {
        const stillPending = pendingAgentRunErrors.has(snapshot.runId);
        if (!stillPending) return;
        redisBgSetSnapshot(snapshot);
        redisBgPublishLifecycle({ runId: snapshot.runId, phase: "error", snapshot });
      }, AGENT_RUN_ERROR_RETRY_GRACE_MS).unref?.();
      return;
    }
    clearPendingAgentRunError(evt.runId);
    recordAgentRunSnapshot(snapshot);
    // Background Redis sync
    redisBgSetSnapshot(snapshot);
    redisBgDeleteStart(evt.runId);
    redisBgPublishLifecycle({ runId: snapshot.runId, phase: "end", snapshot });
  });
}

// ── Public API ─────────────────────────────────────────────────────────────
export async function waitForAgentJob(params: {
  runId: string;
  timeoutMs: number;
}): Promise<AgentRunSnapshot | null> {
  const { runId, timeoutMs } = params;
  ensureAgentRunListener();

  // 1. Check local in-memory cache (same-instance fast path)
  const cached = getCachedAgentRun(runId);
  if (cached) return cached;

  // 2. Check Redis for cross-instance results (no-op when Redis absent)
  const redisCached = await redisGetSnapshot(runId);
  if (redisCached) {
    recordAgentRunSnapshot(redisCached);
    return redisCached;
  }

  if (timeoutMs <= 0) return null;

  const sub = getRedisSubscriber();

  // Register all listeners SYNCHRONOUSLY inside the Promise constructor
  // so no events can slip between the executor running and the first await.
  return new Promise((resolve) => {
    let settled = false;
    let pendingErrorTimer: NodeJS.Timeout | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearPendingErrorTimer = () => {
      if (!pendingErrorTimer) return;
      clearTimeout(pendingErrorTimer);
      pendingErrorTimer = undefined;
    };

    const finish = (entry: AgentRunSnapshot | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearPendingErrorTimer();
      unsubscribeLocal();
      if (sub) {
        sub.unsubscribe(LIFECYCLE_CHANNEL).catch(() => {});
        sub.removeListener("message", onRedisMessage);
      }
      resolve(entry);
    };

    // ── Local event listener ─────────────────────────────────────────────
    const unsubscribeLocal = onAgentEvent((evt) => {
      if (!evt || evt.stream !== "lifecycle") {
        return;
      }
      if (evt.runId !== runId) {
        return;
      }
      const phase = evt.data?.phase;
      if (phase === "start") {
        clearPendingErrorTimer();
        return;
      }
      if (phase !== "end" && phase !== "error") {
        return;
      }
      // Module-level listener runs first and writes to local cache.
      const latest = getCachedAgentRun(runId);
      if (latest) {
        finish(latest);
        return;
      }
      // Fallback: create snapshot directly (should not normally reach here)
      const snapshot = createSnapshotFromLifecycleEvent({
        runId: evt.runId,
        phase,
        data: evt.data,
      });
      if (phase === "error") {
        const effectiveDelay = Math.max(1, Math.min(AGENT_RUN_ERROR_RETRY_GRACE_MS, 2_147_483_647));
        clearPendingErrorTimer();
        pendingErrorTimer = setTimeout(() => {
          const latest2 = getCachedAgentRun(runId);
          finish(latest2 ?? snapshot);
        }, effectiveDelay);
        pendingErrorTimer.unref?.();
        return;
      }
      recordAgentRunSnapshot(snapshot);
      finish(snapshot);
    });

    // ── Redis pub/sub listener ────────────────────────────────────────────
    const onRedisMessage = (_channel: string, raw: string) => {
      if (settled) return;
      const msg = rDeserialise<LifecycleMessage>(raw);
      if (!msg || msg.runId !== runId) return;
      if (msg.phase === "start") return; // run (re)started — keep waiting
      if (msg.snapshot) {
        recordAgentRunSnapshot(msg.snapshot);
        finish(msg.snapshot);
      }
    };

    if (sub) {
      sub.subscribe(LIFECYCLE_CHANNEL).catch(() => finish(null));
      sub.on("message", onRedisMessage);
    }

    const timerDelayMs = Math.max(1, Math.min(Math.floor(timeoutMs), 2_147_483_647));
    timer = setTimeout(() => finish(null), timerDelayMs);

    // Re-check local cache — handles events that fired during the
    // await redisGetSnapshot() gap above (module-level sync listener writes
    // to agentRunCache while per-request listener was not yet registered).
    // All closures are now initialized so finish() is safe to call here.
    const recheckCached = getCachedAgentRun(runId);
    if (recheckCached) {
      finish(recheckCached);
      return;
    }

    // Re-check pending errors registered before our listener was set up.
    const pending = getPendingAgentRunError(runId);
    if (pending) {
      const delayMs = Math.max(1, Math.min(pending.dueAt - Date.now(), 2_147_483_647));
      clearPendingErrorTimer();
      pendingErrorTimer = setTimeout(() => {
        const latest = getCachedAgentRun(runId);
        finish(latest ?? pending.snapshot);
      }, delayMs);
      pendingErrorTimer.unref?.();
    }

    // Async Redis check — runs AFTER all listeners are registered.
    // Handles the case where another instance already finished the run.
    if (sub) {
      redisGetSnapshot(runId)
        .then((crossInstance) => {
          if (settled || !crossInstance) return;
          recordAgentRunSnapshot(crossInstance);
          finish(crossInstance);
        })
        .catch(() => {});
    }
  });
}

ensureAgentRunListener();
