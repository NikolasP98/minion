import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import { isCacheEnabled, resolveCacheTtlMs } from "../../config/cache-utils.js";

type SessionManagerCacheEntry = {
  sessionFile: string;
  loadedAt: number;
};

const SESSION_MANAGER_CACHE = new Map<string, SessionManagerCacheEntry>();
const DEFAULT_SESSION_MANAGER_TTL_MS = 45_000; // 45 seconds
const MAX_CACHE_ENTRIES = 200;

function getSessionManagerTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.MINION_SESSION_MANAGER_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_MANAGER_TTL_MS,
  });
}

function isSessionManagerCacheEnabled(): boolean {
  return isCacheEnabled(getSessionManagerTtl());
}

function pruneStaleEntries(): void {
  const now = Date.now();
  const ttl = getSessionManagerTtl();
  for (const [key, entry] of SESSION_MANAGER_CACHE) {
    if (now - entry.loadedAt > ttl) {
      SESSION_MANAGER_CACHE.delete(key);
    }
  }
}

export function trackSessionManagerAccess(sessionFile: string): void {
  if (!isSessionManagerCacheEnabled()) {
    return;
  }
  const now = Date.now();
  SESSION_MANAGER_CACHE.set(sessionFile, {
    sessionFile,
    loadedAt: now,
  });
  // Evict stale entries when cache grows beyond limit
  if (SESSION_MANAGER_CACHE.size > MAX_CACHE_ENTRIES) {
    pruneStaleEntries();
  }
}

function isSessionManagerCached(sessionFile: string): boolean {
  if (!isSessionManagerCacheEnabled()) {
    return false;
  }
  const entry = SESSION_MANAGER_CACHE.get(sessionFile);
  if (!entry) {
    return false;
  }
  const now = Date.now();
  const ttl = getSessionManagerTtl();
  return now - entry.loadedAt <= ttl;
}

export async function prewarmSessionFile(sessionFile: string): Promise<void> {
  if (!isSessionManagerCacheEnabled()) {
    return;
  }
  if (isSessionManagerCached(sessionFile)) {
    return;
  }

  try {
    // Read a small chunk to encourage OS page cache warmup.
    const handle = await fs.open(sessionFile, "r");
    try {
      const buffer = Buffer.alloc(4096);
      await handle.read(buffer, 0, buffer.length, 0);
    } finally {
      await handle.close();
    }
    trackSessionManagerAccess(sessionFile);
  } catch {
    // File doesn't exist yet, SessionManager will create it
  }
}
