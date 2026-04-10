/**
 * McpServer — MCP 1.1 WebSocket protocol handler.
 *
 * Manages per-connection state and dispatches JSON-RPC requests for:
 *   - initialize / initialized / ping
 *   - resources/list, resources/read, resources/subscribe, resources/unsubscribe
 *   - sampling/createMessage
 *
 * Each connection is bound at connect time to a set of per-tenant roots via
 * RootsEnforcer.  Every resources/read and resources/subscribe call is checked
 * against those roots before proceeding.
 *
 * Sampling requests are forwarded to the RouteLLM router when available,
 * falling back to the configured default model.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { createSubscriptionRegistry } from "./subscription-registry.js";
import { defaultWatcherFactory, DB_ISSUES_ASSIGNED_URI } from "./resource-watcher.js";
import { buildTenantRoots, OPEN_ROOTS, RootsEnforcer } from "./roots-enforcer.js";
import {
  MCP_ERRORS,
  MCP_PROTOCOL_VERSION,
  RPC_ERRORS,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcRequest,
  type McpInitializeResult,
  type McpListResourcesResult,
  type McpReadResult,
  type McpSamplingParams,
  type McpSamplingResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Sampling router interface
// ---------------------------------------------------------------------------

/**
 * A function that handles sampling/createMessage by routing to an LLM.
 * The McpServer calls this when it receives a sampling request.
 * Implementations can use RouteLLM (MIN-329) or fall back to a direct call.
 */
export type SamplingRouter = (params: McpSamplingParams) => Promise<McpSamplingResult>;

// ---------------------------------------------------------------------------
// Server options
// ---------------------------------------------------------------------------

export type McpServerOptions = {
  /**
   * Resolve the tenant ID for an incoming connection.
   * Return null to use OPEN_ROOTS (no roots enforcement, e.g. loopback-only).
   */
  resolveTenantId?: (req: IncomingMessage) => string | null;
  /** Optional LLM sampling router.  Falls back to stub if not provided. */
  samplingRouter?: SamplingRouter;
};

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

type McpConnState = {
  connId: string;
  initialized: boolean;
  tenantId: string | null;
  roots: RootsEnforcer;
};

// ---------------------------------------------------------------------------
// McpServer
// ---------------------------------------------------------------------------

export class McpServer {
  private readonly opts: McpServerOptions;
  private readonly subscriptions = createSubscriptionRegistry({
    watcherFactory: defaultWatcherFactory,
  });
  /** connId → per-connection state */
  private readonly connections = new Map<string, McpConnState>();
  /** connId → send function */
  private readonly sendFns = new Map<string, (msg: unknown) => void>();

  constructor(opts: McpServerOptions = {}) {
    this.opts = opts;
  }

  // ── WebSocket connection lifecycle ────────────────────────────────────────

  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const connId = randomUUID();
    const tenantId = this.opts.resolveTenantId?.(req) ?? null;
    const roots = new RootsEnforcer({
      roots: tenantId ? buildTenantRoots(tenantId) : OPEN_ROOTS,
    });

    const state: McpConnState = { connId, initialized: false, tenantId, roots };
    this.connections.set(connId, state);

    const send = (msg: unknown): void => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };
    this.sendFns.set(connId, send);

    ws.on("message", (data) => {
      void this.handleMessage(connId, data.toString(), send);
    });

    ws.on("close", () => {
      this.subscriptions.unsubscribeAll(connId);
      this.connections.delete(connId);
      this.sendFns.delete(connId);
    });

    ws.on("error", () => {
      this.subscriptions.unsubscribeAll(connId);
      this.connections.delete(connId);
      this.sendFns.delete(connId);
    });
  }

  // ── Message dispatch ──────────────────────────────────────────────────────

  private async handleMessage(
    connId: string,
    raw: string,
    send: (msg: unknown) => void,
  ): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      send(errorResponse(null, RPC_ERRORS.PARSE_ERROR, "Parse error"));
      return;
    }

    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      send(errorResponse(request.id ?? null, RPC_ERRORS.INVALID_REQUEST, "Invalid Request"));
      return;
    }

    const state = this.connections.get(connId);
    if (!state) {
      return;
    }

    const { id, method, params } = request;

    // Notifications (id is absent) — fire-and-forget, no response required.
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case "initialize": {
          const result = this.handleInitialize(state);
          state.initialized = true;
          if (!isNotification) send(okResponse(id, result));
          break;
        }

        case "initialized":
          // Client-side confirmation notification — no response needed.
          break;

        case "ping":
          if (!isNotification) send(okResponse(id, {}));
          break;

        case "resources/list": {
          this.requireInitialized(state);
          const result = this.handleResourcesList();
          if (!isNotification) send(okResponse(id, result));
          break;
        }

        case "resources/read": {
          this.requireInitialized(state);
          const result = await this.handleResourcesRead(state, params);
          if (!isNotification) send(okResponse(id, result));
          break;
        }

        case "resources/subscribe": {
          this.requireInitialized(state);
          this.handleResourcesSubscribe(state, params, send);
          // resources/subscribe is a notification in MCP 1.1 (no response id required
          // when sent as a notification, but respond to requests for compat).
          if (!isNotification) send(okResponse(id, {}));
          break;
        }

        case "resources/unsubscribe": {
          this.requireInitialized(state);
          const uri = extractUri(params);
          this.subscriptions.unsubscribe(connId, uri);
          if (!isNotification) send(okResponse(id, {}));
          break;
        }

        case "sampling/createMessage": {
          this.requireInitialized(state);
          const result = await this.handleSampling(params as McpSamplingParams);
          if (!isNotification) send(okResponse(id, result));
          break;
        }

        default:
          if (!isNotification) {
            send(errorResponse(id, RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`));
          }
      }
    } catch (err) {
      if (!isNotification) {
        const mcpErr = toMcpError(err);
        send(errorResponse(id, mcpErr.code, mcpErr.message, mcpErr.data));
      }
    }
  }

  // ── Method handlers ───────────────────────────────────────────────────────

  private handleInitialize(state: McpConnState): McpInitializeResult {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        resources: { subscribe: true, listChanged: false },
        sampling: {},
      },
      serverInfo: {
        name: "io.github.nikolasp98/minion",
        version: "2026.3.6",
      },
    };
  }

  private handleResourcesList(): McpListResourcesResult {
    return {
      resources: [
        {
          uri: DB_ISSUES_ASSIGNED_URI,
          name: "Assigned Issues",
          description: "Stream of issue/task assignments for this agent session.",
          mimeType: "application/json",
        },
      ],
    };
  }

  private async handleResourcesRead(
    state: McpConnState,
    params: unknown,
  ): Promise<McpReadResult> {
    const uri = extractUri(params);
    this.enforceRoots(state, uri);

    if (uri === DB_ISSUES_ASSIGNED_URI) {
      // Return current snapshot — clients should subscribe for live updates.
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ subscriptions: this.subscriptions.activeUriCount() }),
          },
        ],
      };
    }

    throw mcpError(MCP_ERRORS.RESOURCE_NOT_FOUND, `Resource not found: ${uri}`);
  }

  private handleResourcesSubscribe(
    state: McpConnState,
    params: unknown,
    send: (msg: unknown) => void,
  ): void {
    const uri = extractUri(params);
    this.enforceRoots(state, uri);

    const notifySend = (connId: string, notifyUri: string, changeType: string) => {
      const fn = this.sendFns.get(connId);
      if (fn) {
        fn({
          jsonrpc: "2.0",
          method: "notifications/resources/updated",
          params: { uri: notifyUri, changeType },
        });
      }
    };

    const result = this.subscriptions.subscribe(state.connId, uri, notifySend);
    if (!result.ok) {
      throw mcpError(MCP_ERRORS.SUBSCRIPTION_LIMIT, result.error ?? "subscription failed");
    }
  }

  private async handleSampling(params: McpSamplingParams): Promise<McpSamplingResult> {
    if (this.opts.samplingRouter) {
      return this.opts.samplingRouter(params);
    }
    // Stub: echo the last user message back — real routing wired via MIN-329.
    const lastUser = [...params.messages].reverse().find((m) => m.role === "user");
    return {
      role: "assistant",
      content: {
        type: "text",
        text: `[sampling stub] received: ${lastUser?.content.text ?? "(empty)"}`,
      },
      model: "stub",
      stopReason: "endTurn",
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private requireInitialized(state: McpConnState): void {
    if (!state.initialized) {
      throw mcpError(RPC_ERRORS.INVALID_REQUEST, "Client must send initialize first");
    }
  }

  private enforceRoots(state: McpConnState, uri: string): void {
    const check = state.roots.check(uri);
    if (!check.allowed) {
      throw mcpError(MCP_ERRORS.FORBIDDEN, check.reason);
    }
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  getActiveConnectionCount(): number {
    return this.connections.size;
  }

  getActiveSubscriptionCount(): number {
    return this.subscriptions.activeUriCount();
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function okResponse(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
) {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function extractUri(params: unknown): string {
  if (
    typeof params === "object" &&
    params !== null &&
    "uri" in params &&
    typeof (params as { uri: unknown }).uri === "string"
  ) {
    return (params as { uri: string }).uri;
  }
  throw mcpError(RPC_ERRORS.INVALID_PARAMS, "Missing or invalid 'uri' in params");
}

type McpErrorShape = { code: number; message: string; data?: unknown };

function mcpError(code: number, message: string, data?: unknown): McpErrorShape & Error {
  const err = new Error(message) as McpErrorShape & Error;
  err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

function toMcpError(err: unknown): { code: number; message: string; data?: unknown } {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "number"
  ) {
    const e = err as { code: number; message?: unknown; data?: unknown };
    return {
      code: e.code,
      message: typeof e.message === "string" ? e.message : "error",
      data: e.data,
    };
  }
  return {
    code: RPC_ERRORS.INTERNAL_ERROR,
    message: err instanceof Error ? err.message : "Internal error",
  };
}
