/**
 * MCP 1.1 protocol types — JSON-RPC 2.0 message shapes.
 * Only the subset needed for resource subscriptions, roots enforcement, and sampling.
 */

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError };

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

/** Standard JSON-RPC error codes */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** MCP-specific error codes (application layer) */
export const MCP_ERRORS = {
  FORBIDDEN: -32001,
  RESOURCE_NOT_FOUND: -32002,
  SUBSCRIPTION_LIMIT: -32003,
  SAMPLING_ERROR: -32004,
} as const;

export type McpResourceContent = {
  uri: string;
  mimeType?: string;
  text?: string;
};

export type McpResourceInfo = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

/** parameters for resources/subscribe */
export type McpSubscribeParams = {
  uri: string;
};

/** parameters for resources/unsubscribe */
export type McpUnsubscribeParams = {
  uri: string;
};

/** parameters for resources/read */
export type McpReadParams = {
  uri: string;
};

export type McpReadResult = {
  contents: McpResourceContent[];
};

export type McpListResourcesResult = {
  resources: McpResourceInfo[];
};

/** parameters for sampling/createMessage */
export type McpSamplingParams = {
  messages: Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
  modelPreferences?: {
    hints?: Array<{ name?: string }>;
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
  };
  systemPrompt?: string;
  includeContext?: "none" | "thisServer" | "allServers";
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  metadata?: unknown;
};

export type McpSamplingResult = {
  role: "assistant";
  content: { type: "text"; text: string };
  model: string;
  stopReason?: "endTurn" | "maxTokens" | "stopSequence";
};

/** MCP 1.1 server capabilities advertised during initialize */
export type McpServerCapabilities = {
  resources?: { subscribe?: boolean; listChanged?: boolean };
  sampling?: Record<string, never>;
};

/** MCP 1.1 initialize result */
export type McpInitializeResult = {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: { name: string; version: string };
};

export const MCP_PROTOCOL_VERSION = "2024-11-05";
