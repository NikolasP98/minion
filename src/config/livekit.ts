/**
 * LiveKit Cloud configuration and server-side room management.
 *
 * Uses livekit-server-sdk for room creation, access token generation,
 * and SIP trunk operations.
 */

// -----------------------------------------------------------------------------
// Config types
// -----------------------------------------------------------------------------

export type LiveKitConfig = {
  /** LiveKit Cloud API key (env: LIVEKIT_API_KEY) */
  apiKey: string;
  /** LiveKit Cloud API secret (env: LIVEKIT_API_SECRET) */
  apiSecret: string;
  /** LiveKit Cloud WebSocket URL (env: LIVEKIT_URL, e.g. wss://myapp.livekit.cloud) */
  wsUrl: string;
};

export type RoomOptions = {
  /** Max participants allowed in the room */
  maxParticipants?: number;
  /** Auto-delete room after all participants leave (seconds) */
  emptyTimeoutSec?: number;
};

export type AgentTokenOptions = {
  /** Participant identity (must be unique in the room) */
  identity: string;
  /** Human-readable participant name */
  name?: string;
  /** Token TTL in seconds (default: 3600) */
  ttlSec?: number;
};

// -----------------------------------------------------------------------------
// Config resolution
// -----------------------------------------------------------------------------

/**
 * Load LiveKit config from environment variables.
 * Throws if any required variable is missing.
 */
export function loadLiveKitConfig(): LiveKitConfig {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.LIVEKIT_URL;

  if (!apiKey) {
    throw new Error("LIVEKIT_API_KEY environment variable is not set");
  }
  if (!apiSecret) {
    throw new Error("LIVEKIT_API_SECRET environment variable is not set");
  }
  if (!wsUrl) {
    throw new Error("LIVEKIT_URL environment variable is not set");
  }

  return { apiKey, apiSecret, wsUrl };
}

/**
 * Return true if all required LiveKit environment variables are present.
 * Use this for a capability check before attempting a connection.
 */
export function isLiveKitConfigured(): boolean {
  return Boolean(
    process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET &&
      process.env.LIVEKIT_URL,
  );
}

// -----------------------------------------------------------------------------
// Room management (livekit-server-sdk)
// -----------------------------------------------------------------------------

/**
 * Lazily import livekit-server-sdk so the module can be loaded even when the
 * package is not installed (the import only runs when the feature is actually used).
 */
async function getLiveKitServerSdk() {
  try {
    // livekit-server-sdk exports AccessToken and RoomServiceClient
    const sdk = await import("livekit-server-sdk");
    return sdk;
  } catch {
    throw new Error(
      "livekit-server-sdk is not installed. " +
        "Run: pnpm add livekit-server-sdk",
    );
  }
}

/**
 * Generate a LiveKit access token for an agent or user participant.
 *
 * @param config - LiveKit credentials
 * @param roomName - Room the participant will join
 * @param opts - Identity and TTL options
 * @returns JWT string that the participant uses to connect
 */
export async function generateRoomToken(
  config: LiveKitConfig,
  roomName: string,
  opts: AgentTokenOptions,
): Promise<string> {
  const sdk = await getLiveKitServerSdk();
  const { AccessToken } = sdk;

  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity: opts.identity,
    name: opts.name ?? opts.identity,
    ttl: opts.ttlSec ?? 3600,
  });

  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return at.toJwt();
}

/**
 * Create a new LiveKit room using the Room Service API.
 * If a room with the same name already exists, returns normally (idempotent).
 *
 * @param config - LiveKit credentials
 * @param roomName - Unique room identifier
 * @param opts - Room creation options
 */
export async function createRoom(
  config: LiveKitConfig,
  roomName: string,
  opts: RoomOptions = {},
): Promise<void> {
  const sdk = await getLiveKitServerSdk();
  const { RoomServiceClient } = sdk;

  // Convert wss:// → https:// for the HTTP API endpoint
  const httpUrl = config.wsUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://");

  const svc = new RoomServiceClient(httpUrl, config.apiKey, config.apiSecret);

  await svc.createRoom({
    name: roomName,
    maxParticipants: opts.maxParticipants ?? 10,
    emptyTimeout: opts.emptyTimeoutSec ?? 300,
  });
}

/**
 * Delete a LiveKit room, disconnecting all participants.
 *
 * @param config - LiveKit credentials
 * @param roomName - Room to delete
 */
export async function deleteRoom(
  config: LiveKitConfig,
  roomName: string,
): Promise<void> {
  const sdk = await getLiveKitServerSdk();
  const { RoomServiceClient } = sdk;

  const httpUrl = config.wsUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://");

  const svc = new RoomServiceClient(httpUrl, config.apiKey, config.apiSecret);
  await svc.deleteRoom(roomName);
}

/**
 * Generate a stable room name for a Minion conversation session.
 */
export function roomNameForSession(sessionId: string): string {
  return `minion-session-${sessionId}`;
}
