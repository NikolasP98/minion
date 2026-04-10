/**
 * MCP 1.1 module — public exports for the Minion gateway.
 *
 * Usage:
 *   import { McpServer, assignmentBus, ASSIGNMENT_EVENT } from "../mcp/index.js";
 *
 *   // Wire assignment events from chat run lifecycle:
 *   addChatRun(...);
 *   assignmentBus.emit(ASSIGNMENT_EVENT);
 *
 *   // Wire the WebSocket handler:
 *   mcpServer.handleConnection(ws, req);
 */

export { McpServer } from "./mcp-server.js";
export type { McpServerOptions, SamplingRouter } from "./mcp-server.js";

export { assignmentBus, ASSIGNMENT_EVENT, DB_ISSUES_ASSIGNED_URI, defaultWatcherFactory, DbIssuesAssignedWatcher } from "./resource-watcher.js";

export { createSubscriptionRegistry } from "./subscription-registry.js";
export type { ResourceWatcher, ResourceWatcherFactory, SubscriptionRegistry } from "./subscription-registry.js";

export { RootsEnforcer, buildTenantRoots, OPEN_ROOTS } from "./roots-enforcer.js";
export type { ResourceRoot } from "./roots-enforcer.js";

export { MCP_PROTOCOL_VERSION, MCP_ERRORS, RPC_ERRORS } from "./types.js";
export type {
  McpServerCapabilities,
  McpInitializeResult,
  McpSamplingParams,
  McpSamplingResult,
} from "./types.js";
