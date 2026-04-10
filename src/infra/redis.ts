/**
 * Optional Redis client for distributed state.
 *
 * Returns null when REDIS_URL is not configured, allowing single-instance
 * deployments to continue using in-memory Maps without code changes.
 *
 * When REDIS_URL is set, all critical in-process Maps are backed by Redis,
 * enabling stateless horizontal scaling with no sticky-session requirements.
 */
import Redis from "ioredis";
import { logWarn } from "../logger.js";

let client: Redis | null = null;
let subscriber: Redis | null = null;
let initialized = false;

function buildClient(url: string): Redis {
  return new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    lazyConnect: true,
  });
}

function init() {
  if (initialized) return;
  initialized = true;
  const url = process.env.REDIS_URL;
  if (!url) {
    logWarn(
      "REDIS_URL not set — running in single-instance mode. " +
        "Horizontal scaling requires a shared Redis instance.",
    );
    return;
  }
  client = buildClient(url);
  subscriber = buildClient(url);
}

/**
 * Returns the shared Redis client, or null if REDIS_URL is not configured.
 * Use for all read/write operations.
 */
export function getRedisClient(): Redis | null {
  init();
  return client;
}

/**
 * Returns a dedicated subscriber Redis connection, or null if REDIS_URL is
 * not configured. ioredis requires a separate connection for pub/sub.
 */
export function getRedisSubscriber(): Redis | null {
  init();
  return subscriber;
}

/** Build a namespaced Redis key: "minion:<segments...>" */
export function mkKey(...segments: string[]): string {
  return `minion:${segments.join(":")}`;
}

/** Serialise a value to JSON for storage. */
export function rSerialise<T>(value: T): string {
  return JSON.stringify(value);
}

/** Deserialise a JSON string. Returns null on parse failure. */
export function rDeserialise<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Reset module state — for unit tests only. */
export function __resetRedisForTest() {
  client?.disconnect();
  subscriber?.disconnect();
  client = null;
  subscriber = null;
  initialized = false;
}
