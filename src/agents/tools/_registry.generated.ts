// AUTO-GENERATED — do not edit. Run: pnpm generate:tools

import type { ToolMeta } from "../tool-meta.js";

export type ToolRegistryEntry = {
  meta: ToolMeta;
  load: () => Promise<Record<string, unknown>>;
};

export const TOOL_REGISTRY: Record<string, ToolRegistryEntry> = {
  "agents_list": {
    meta: { id: "agents_list", factory: "createAgentsListTool", groups: ["group:minion"], contextKeys: ["agentSessionKey","requesterAgentIdOverride"] },
    load: () => import("./agents-list-tool.js"),
  },
  "architect_pipeline": {
    meta: { id: "architect_pipeline", factory: "createArchitectPipelineTool", groups: ["group:minion"], contextKeys: ["workspaceDir"] },
    load: () => import("./architect-pipeline-tool.js"),
  },
  "browser": {
    meta: { id: "browser", factory: "createBrowserTool", groups: ["group:ui","group:minion"], contextKeys: ["sandboxBrowserBridgeUrl","allowHostBrowserControl"] },
    load: () => import("./browser-tool.js"),
  },
  "canvas": {
    meta: { id: "canvas", factory: "createCanvasTool", groups: ["group:ui","group:minion"], contextKeys: ["config"] },
    load: () => import("./canvas-tool.js"),
  },
  "cron": {
    meta: { id: "cron", factory: "createCronTool", groups: ["group:automation","group:minion"], contextKeys: ["agentSessionKey"] },
    load: () => import("./cron-tool.js"),
  },
  "gateway": {
    meta: { id: "gateway", factory: "createGatewayTool", groups: ["group:automation","group:minion"], contextKeys: ["agentSessionKey","config"] },
    load: () => import("./gateway-tool.js"),
  },
  "gog_auth_revoke": {
    meta: { id: "gog_auth_revoke", factory: "createGogAuthRevokeTool", groups: ["group:gog","group:minion"], contextKeys: ["agentId","agentDir","agentSessionKey"], condition: "gogOAuthEnabled" },
    load: () => import("./gog-auth-revoke-tool.js"),
  },
  "gog_auth_start": {
    meta: { id: "gog_auth_start", factory: "createGogAuthStartTool", groups: ["group:gog","group:minion"], contextKeys: ["agentId","agentDir","agentSessionKey"], condition: "gogOAuthEnabled" },
    load: () => import("./gog-auth-start-tool.js"),
  },
  "gog_auth_status": {
    meta: { id: "gog_auth_status", factory: "createGogAuthStatusTool", groups: ["group:gog","group:minion"], contextKeys: ["agentId","agentSessionKey"], condition: "gogOAuthEnabled" },
    load: () => import("./gog-auth-status-tool.js"),
  },
  "gog_exec": {
    meta: { id: "gog_exec", factory: "createGogExecTool", groups: ["group:gog","group:minion"], contextKeys: ["agentId","agentSessionKey"], condition: "gogOAuthEnabled" },
    load: () => import("./gog-exec-tool.js"),
  },
  "image": {
    meta: { id: "image", factory: "createImageTool", groups: ["group:minion"], contextKeys: ["config","agentDir","workspaceDir","sandboxRoot","sandboxFsBridge","modelHasVision"], condition: "hasAgentDir" },
    load: () => import("./image-tool.js"),
  },
  "knowledge_graph": {
    meta: { id: "knowledge_graph", factory: "createKnowledgeGraphTools", groups: ["group:memory","group:minion"], multi: true, modulePath: "../../memory/knowledge-graph.js" },
    load: () => import("../../memory/knowledge-graph.js"),
  },
  "message": {
    meta: { id: "message", factory: "createMessageTool", groups: ["group:messaging","group:minion"], contextKeys: ["agentAccountId","agentSessionKey","config","currentChannelId","agentChannel","currentThreadTs","replyToMode","hasRepliedRef","sandboxRoot","requireExplicitMessageTarget"], condition: "messageEnabled" },
    load: () => import("./message-tool.js"),
  },
  "nodes": {
    meta: { id: "nodes", factory: "createNodesTool", groups: ["group:nodes","group:minion"], contextKeys: ["agentSessionKey","config"] },
    load: () => import("./nodes-tool.js"),
  },
  "parse_screen": {
    meta: { id: "parse_screen", factory: "createParseScreenTool", groups: ["group:ui","group:minion"], contextKeys: ["config"], condition: "omniparserEnabled" },
    load: () => import("./parse-screen-tool.js"),
  },
  "session_status": {
    meta: { id: "session_status", factory: "createSessionStatusTool", groups: ["group:sessions","group:minion"], contextKeys: ["agentSessionKey","config"] },
    load: () => import("./session-status-tool.js"),
  },
  "sessions_history": {
    meta: { id: "sessions_history", factory: "createSessionsHistoryTool", groups: ["group:sessions","group:minion"], contextKeys: ["agentSessionKey","sandboxed"] },
    load: () => import("./sessions-history-tool.js"),
  },
  "sessions_list": {
    meta: { id: "sessions_list", factory: "createSessionsListTool", groups: ["group:sessions","group:minion"], contextKeys: ["agentSessionKey","sandboxed"] },
    load: () => import("./sessions-list-tool.js"),
  },
  "sessions_send": {
    meta: { id: "sessions_send", factory: "createSessionsSendTool", groups: ["group:sessions","group:minion"], contextKeys: ["agentSessionKey","agentChannel","sandboxed"] },
    load: () => import("./sessions-send-tool.js"),
  },
  "sessions_spawn": {
    meta: { id: "sessions_spawn", factory: "createSessionsSpawnTool", groups: ["group:sessions","group:minion"], contextKeys: ["agentSessionKey","agentChannel","agentAccountId","agentTo","agentThreadId","agentGroupId","agentGroupChannel","agentGroupSpace","sandboxed","requesterAgentIdOverride"] },
    load: () => import("./sessions-spawn-tool.js"),
  },
  "subagents": {
    meta: { id: "subagents", factory: "createSubagentsTool", groups: ["group:sessions","group:minion"], contextKeys: ["agentSessionKey"] },
    load: () => import("./subagents-tool.js"),
  },
  "summarize": {
    meta: { id: "summarize", factory: "createSummarizeTool", groups: ["group:minion"], skillPromptFile: "./summarize-tool.skill.md", requires: {"bins":["summarize"]}, mcpExport: true },
    load: () => import("./summarize-tool.js"),
  },
  "tts": {
    meta: { id: "tts", factory: "createTtsTool", groups: ["group:minion"], contextKeys: ["agentChannel","config"] },
    load: () => import("./tts-tool.js"),
  },
  "venture_studio": {
    meta: { id: "venture_studio", factory: "createVentureStudioTool", groups: ["group:minion"], contextKeys: ["workspaceDir"] },
    load: () => import("./venture-studio-tool.js"),
  },
  "web_fetch": {
    meta: { id: "web_fetch", factory: "createWebFetchTool", groups: ["group:web","group:minion"], contextKeys: ["config","sandboxed"] },
    load: () => import("./web-fetch.js"),
  },
  "web_search": {
    meta: { id: "web_search", factory: "createWebSearchTool", groups: ["group:web","group:minion"], contextKeys: ["config","sandboxed"] },
    load: () => import("./web-search.js"),
  },
};
