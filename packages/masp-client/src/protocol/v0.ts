/**
 * MASP v0 — MINION App Server Protocol baseline types
 *
 * This file is the formal TypeScript spec for the implicit WebSocket protocol
 * currently in use between Gateway server and all first-party clients (Hub,
 * Desktop, CLI). It was reverse-engineered from:
 *
 *   - src/gateway/protocol/schema/frames.ts         (authoritative server schema)
 *   - src/gateway/protocol/schema/snapshot.ts
 *   - src/gateway/protocol/schema/primitives.ts
 *   - src/gateway/protocol/client-info.ts
 *   - src/gateway/server-core/server-methods-list.ts (method/event registry)
 *   - ui/src/ui/gateway.ts                           (Hub browser client)
 *   - apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift (Desktop)
 *
 * See docs/masp-v0.md for the prose specification.
 *
 * Current negotiated protocol version: 3
 *
 * @see MIN-372 — Audit issue that produced this file
 * @see MIN-38  — MASP architecture decision (ARCH: Unified App Server Protocol)
 */

// ---------------------------------------------------------------------------
// Wire protocol version
// ---------------------------------------------------------------------------

/** Negotiated protocol version this spec describes. */
export const MASP_V0_PROTOCOL_VERSION = 3;

// ---------------------------------------------------------------------------
// Client identity
// ---------------------------------------------------------------------------

/** Known first-party client identifiers (sent in ConnectParams.client.id). */
export type GatewayClientId =
  | "webchat-ui"
  | "minion-control-ui"
  | "webchat"
  | "cli"
  | "gateway-client"
  | "minion-macos"
  | "minion-ios"
  | "minion-android"
  | "node-host"
  | "test"
  | "fingerprint"
  | "minion-probe";

/** Known client modes (sent in ConnectParams.client.mode). */
export type GatewayClientMode = "webchat" | "cli" | "ui" | "backend" | "node" | "probe" | "test";

/** Optional client capability flags. */
export type GatewayClientCap = "tool-events";

// ---------------------------------------------------------------------------
// Core wire frames  (discriminated union on `type`)
// ---------------------------------------------------------------------------

/**
 * REQUEST frame — client → server
 *
 * Initiates a remote method call. The server replies with a matching
 * RESPONSE frame carrying the same `id`.
 */
export interface RequestFrame {
  type: "req";
  /** UUID that correlates the matching ResponseFrame. */
  id: string;
  /** Method name, e.g. `"chat.send"`. */
  method: string;
  /** Method-specific parameters. Omit when the method takes no params. */
  params?: unknown;
}

/**
 * RESPONSE frame — server → client
 *
 * Sent exactly once for each RequestFrame. Never broadcast; always
 * unicast to the connection that sent the matching request.
 */
export interface ResponseFrame {
  type: "res";
  /** Echoes RequestFrame.id. */
  id: string;
  /** `true` on success, `false` on error. */
  ok: boolean;
  /** Present when ok === true. Shape is method-specific. */
  payload?: unknown;
  /** Present when ok === false. */
  error?: ErrorShape;
}

/**
 * EVENT frame — server → client (broadcast / push)
 *
 * Unsolicited push from the server. Events are not matched to a request.
 * They may be broadcast to all connections or filtered by scope.
 */
export interface EventFrame {
  type: "event";
  /** Event name, e.g. `"chat"`, `"tick"`. */
  event: string;
  /** Event-specific payload. Shape is event-specific. */
  payload?: unknown;
  /**
   * Monotonically increasing sequence number, per connection.
   * Used for gap detection. Not present on all events.
   */
  seq?: number;
  /**
   * State snapshot version at the time of the event.
   * Absent on heartbeat/tick events.
   */
  stateVersion?: StateVersion;
}

/** Top-level discriminated union of all MASP v0 wire frames. */
export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/** Structured error returned in ResponseFrame when ok === false. */
export interface ErrorShape {
  /** Stable error code string. */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Optional structured details (shape varies by error). */
  details?: unknown;
  /** Whether the client may safely retry. */
  retryable?: boolean;
  /** Suggested retry delay in milliseconds. */
  retryAfterMs?: number;
}

/** Snapshot version counters for presence and health state. */
export interface StateVersion {
  /** Monotonically increasing version of the presence list. */
  presence: number;
  /** Monotonically increasing version of the health object. */
  health: number;
}

// ---------------------------------------------------------------------------
// Handshake protocol
// ---------------------------------------------------------------------------

/**
 * PHASE 0 — challenge event (server → client, first message on connect)
 *
 * Sent immediately when the TCP/WebSocket connection is accepted, before
 * the client sends its ConnectParams. The client MUST respond with a
 * ConnectParams that echoes `nonce` in `device.nonce` if using device auth.
 *
 * Event name: `"connect.challenge"`
 */
export interface ConnectChallengePayload {
  /** Random nonce for device signature binding. */
  nonce: string;
  /** Server wall-clock time in milliseconds since epoch. */
  ts: number;
}

/**
 * PHASE 1 — connect request (client → server)
 *
 * Sent as `method: "connect"` in a RequestFrame.
 */
export interface ConnectParams {
  /** Minimum protocol version the client accepts. */
  minProtocol: number;
  /** Maximum protocol version the client accepts. */
  maxProtocol: number;
  /** Identifying information about the connecting client. */
  client: {
    id: GatewayClientId;
    displayName?: string;
    version: string;
    platform: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    mode: GatewayClientMode;
    instanceId?: string;
  };
  /** Declared capability flags (e.g. `["tool-events"]`). Default: `[]`. */
  caps?: string[];
  /** CLI command names supported by this client. */
  commands?: string[];
  /** Permission grants declared by the client. */
  permissions?: Record<string, boolean>;
  /**
   * `PATH` environment variable string.
   * Present in CLI/backend clients; absent from browser/mobile clients.
   */
  pathEnv?: string;
  /** Auth role: `"operator"` (default) or `"node"`. */
  role?: string;
  /** Authorization scopes being requested. */
  scopes?: string[];
  /** Device identity for persistent device authentication. */
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    /** Echo of ConnectChallengePayload.nonce — required for v2 device signing. */
    nonce?: string;
  };
  /** Token or password authentication credentials. */
  auth?: {
    token?: string;
    password?: string;
  };
  /** BCP 47 locale string, e.g. `"en-US"`. Sent by browser/mobile clients. */
  locale?: string;
  /** HTTP User-Agent string. Sent by browser clients. */
  userAgent?: string;
}

/**
 * PHASE 2 — hello-ok response (server → client)
 *
 * Successful response to the `"connect"` request. Contains the negotiated
 * protocol, server info, full state snapshot, and session policy.
 */
export interface HelloOk {
  type: "hello-ok";
  /** Negotiated protocol version (≥ ConnectParams.minProtocol). */
  protocol: number;
  server: {
    version: string;
    commit?: string;
    host?: string;
    /** Server-assigned connection ID (unique per connection). */
    connId: string;
  };
  features: {
    /** List of method names the server supports. */
    methods: string[];
    /** List of event names the server may broadcast. */
    events: string[];
  };
  /** Full state snapshot delivered on initial connect. */
  snapshot: Snapshot;
  /** Canvas host URL if canvas feature is enabled. */
  canvasHostUrl?: string;
  /** Issued device auth credentials (present when device auth succeeded). */
  auth?: {
    deviceToken: string;
    role: string;
    scopes: string[];
    issuedAtMs?: number;
  };
  /** Connection policy limits. */
  policy: {
    /** Maximum WebSocket message size in bytes (currently 25 MiB). */
    maxPayload: number;
    /** Maximum bytes the server will buffer per connection. */
    maxBufferedBytes: number;
    /** Interval between `tick` events in milliseconds (currently 30 000). */
    tickIntervalMs: number;
  };
}

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

/** Full state snapshot delivered in HelloOk and on reconnect. */
export interface Snapshot {
  presence: PresenceEntry[];
  /** Current health object (shape is internal / unversioned). */
  health: unknown;
  stateVersion: StateVersion;
  /** Server uptime in milliseconds. */
  uptimeMs: number;
  configPath?: string;
  stateDir?: string;
  sessionDefaults?: SessionDefaults;
  authMode?: "none" | "token" | "password" | "trusted-proxy";
}

/** Single entry in the presence list (one per active connection). */
export interface PresenceEntry {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  mode?: string;
  lastInputSeconds?: number;
  reason?: string;
  tags?: string[];
  text?: string;
  ts: number;
  deviceId?: string;
  roles?: string[];
  scopes?: string[];
  instanceId?: string;
}

/** Default session identifiers returned in the snapshot. */
export interface SessionDefaults {
  defaultAgentId: string;
  mainKey: string;
  mainSessionKey: string;
  scope?: string;
}

// ---------------------------------------------------------------------------
// Known event payloads
// ---------------------------------------------------------------------------

/**
 * `"tick"` — periodic keep-alive heartbeat (server → all clients).
 *
 * Sent every `policy.tickIntervalMs` ms (default 30 s).
 * Clients MUST disconnect / reconnect if ticks stop arriving for
 * ~3× `tickIntervalMs`.
 */
export interface TickEventPayload {
  ts: number;
}

/**
 * `"shutdown"` — server is shutting down (server → all clients).
 *
 * Clients SHOULD reconnect after `restartExpectedMs` if present.
 */
export interface ShutdownEventPayload {
  reason: string;
  restartExpectedMs?: number;
}

/**
 * `"health"` — updated health snapshot (server → all clients).
 *
 * Shape of `health` is internal and not formally versioned in MASP v0.
 */
export type HealthEventPayload = unknown;

/**
 * `"chat"` — streamed chat delta (server → subscribed clients).
 * Shape is defined in src/gateway/protocol/schema/logs-chat.ts.
 */
export type ChatEventPayload = unknown;

/**
 * `"agent"` — agent execution event (server → subscribed clients).
 * Shape is defined in src/gateway/protocol/schema/agent.ts.
 */
export type AgentEventPayload = unknown;

/**
 * `"cron"` — cron job lifecycle event (server → all clients).
 * Shape is defined in src/gateway/protocol/schema/cron.ts.
 */
export type CronEventPayload = unknown;

/**
 * `"heartbeat"` — generic heartbeat event (server → all clients).
 * Distinct from `tick`; carries richer agent-loop heartbeat data.
 */
export type HeartbeatEventPayload = unknown;

/**
 * `"node.pair.requested"` — pairing request from a new node.
 * Scope-guarded: only sent to `operator.pairing` scope.
 */
export type NodePairRequestedPayload = unknown;

/**
 * `"device.pair.requested"` — pairing request from a new device.
 * Scope-guarded: only sent to `operator.pairing` scope.
 */
export type DevicePairRequestedPayload = unknown;

/**
 * `"exec.approval.requested"` — HITL approval needed before tool call.
 * Scope-guarded: only sent to `operator.approvals` scope.
 */
export type ExecApprovalRequestedPayload = unknown;

/**
 * `"exec.approval.resolved"` — HITL approval resolved.
 * Scope-guarded: only sent to `operator.approvals` scope.
 */
export type ExecApprovalResolvedPayload = unknown;

/**
 * `"talk.mode"` — push-to-talk mode changed.
 */
export type TalkModePayload = unknown;

/**
 * `"voicewake.changed"` — voice wake configuration changed.
 */
export interface VoicewakeChangedPayload {
  triggers: unknown[];
}

// ---------------------------------------------------------------------------
// Method registry
// ---------------------------------------------------------------------------

/**
 * All gateway method names defined in MASP v0.
 *
 * Methods are invoked via RequestFrame and always receive a ResponseFrame.
 * This list is normative as of the audit date (2026-04-10).
 */
export type GatewayMethod =
  // Handshake
  | "connect"
  // Agent management
  | "agent"
  | "agent.wait"
  | "agent.identity.get"
  | "agent.install"
  | "agents.list"
  | "agents.create"
  | "agents.update"
  | "agents.delete"
  | "agents.files.list"
  | "agents.files.get"
  | "agents.files.set"
  | "agents.skills.set"
  // Chat
  | "chat.send"
  | "chat.history"
  | "chat.inject"
  | "chat.abort"
  // Sessions
  | "sessions.list"
  | "sessions.preview"
  | "sessions.resolve"
  | "sessions.patch"
  | "sessions.reset"
  | "sessions.delete"
  | "sessions.compact"
  | "sessions.usage"
  | "sessions.usage.timeseries"
  | "sessions.usage.logs"
  // Outbound send
  | "send"
  | "poll"
  // Nodes
  | "node.list"
  | "node.describe"
  | "node.invoke"
  | "node.invoke.result"
  | "node.event"
  | "node.rename"
  | "node.pair.request"
  | "node.pair.list"
  | "node.pair.approve"
  | "node.pair.reject"
  | "node.pair.verify"
  // Devices
  | "device.pair.list"
  | "device.pair.approve"
  | "device.pair.reject"
  | "device.pair.remove"
  | "device.token.rotate"
  | "device.token.revoke"
  // Configuration
  | "config.get"
  | "config.set"
  | "config.patch"
  | "config.apply"
  | "config.schema"
  // Skills
  | "skills.status"
  | "skills.bins"
  | "skills.install"
  | "skills.update"
  // Models
  | "models.list"
  // Tools
  | "tools.status"
  | "tools.update"
  | "tools.reload"
  | "tools.overrides.set"
  // TTS
  | "tts.status"
  | "tts.enable"
  | "tts.disable"
  | "tts.convert"
  | "tts.providers"
  | "tts.setProvider"
  // Voice wake
  | "voicewake.get"
  | "voicewake.set"
  // Cron
  | "cron.list"
  | "cron.status"
  | "cron.add"
  | "cron.update"
  | "cron.remove"
  | "cron.run"
  | "cron.runs"
  // Approvals
  | "exec.approval.request"
  | "exec.approval.resolve"
  | "exec.approvals.get"
  | "exec.approvals.set"
  | "exec.approvals.node.get"
  | "exec.approvals.node.set"
  // Web login
  | "web.login.start"
  | "web.login.wait"
  // Channels
  | "channels.status"
  | "channels.logout"
  | "talk.mode"
  | "talk.config"
  // System
  | "health"
  | "status"
  | "last-heartbeat"
  | "set-heartbeats"
  | "system-presence"
  | "system-event"
  // Logging
  | "logs.tail"
  // Reliability
  | "reliability.events"
  | "reliability.summary"
  | "update.run"
  // Memory / misc
  | "memory.snapshot"
  | "specialists.status"
  | "usage.status"
  | "usage.cost"
  | "push.test"
  | "browser.request"
  // Mesh
  | "mesh.plan"
  | "mesh.plan.auto"
  | "mesh.run"
  | "mesh.status"
  | "mesh.retry"
  // Wizard
  | "wizard.start"
  | "wizard.next"
  | "wizard.cancel"
  | "wizard.status";

/**
 * All broadcast event names defined in MASP v0.
 *
 * Events are pushed by the server via EventFrame without a corresponding
 * RequestFrame.
 */
export type GatewayEventName =
  | "connect.challenge"
  | "tick"
  | "health"
  | "chat"
  | "agent"
  | "cron"
  | "shutdown"
  | "heartbeat"
  | "voicewake.changed"
  | "node.pair.requested"
  | "node.pair.resolved"
  | "node.invoke.request"
  | "device.pair.requested"
  | "device.pair.resolved"
  | "exec.approval.requested"
  | "exec.approval.resolved"
  | "talk.mode"
  | "reliability";
