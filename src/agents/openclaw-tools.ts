import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { KnowledgeGraphSession } from "../memory/knowledge-graph.js";
import { resolvePluginTools } from "../plugins/tools.js";
import type { GatewayMessageChannel } from "../shared/message-channel.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { resolveWorkspaceRoot } from "./identity/workspace-dir.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { TOOL_REGISTRY, type ToolRegistryEntry } from "./tools/_registry.generated.js";
import type { AnyAgentTool } from "./tools/common.js";

export type CreateOpenClawToolsOptions = {
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
  agentTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  agentThreadId?: string | number;
  /** Group id for channel-level tool policy inheritance. */
  agentGroupId?: string | null;
  /** Group channel label for channel-level tool policy inheritance. */
  agentGroupChannel?: string | null;
  /** Group space label for channel-level tool policy inheritance. */
  agentGroupSpace?: string | null;
  agentDir?: string;
  sandboxRoot?: string;
  sandboxFsBridge?: SandboxFsBridge;
  workspaceDir?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  pluginToolAllowlist?: string[];
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
  /** Require explicit message targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
};

/**
 * Derived context computed once from options, shared across all factory calls.
 */
type ToolContext = {
  options: CreateOpenClawToolsOptions | undefined;
  workspaceDir: string;
  agentId: string;
  kgSession: KnowledgeGraphSession | undefined;
  gogOAuthEnabled: boolean;
};

/**
 * Tool order: preserves the exact registration order from the previous
 * manual implementation. New tools should be appended at the end.
 */
const TOOL_ORDER: string[] = [
  "browser",
  "canvas",
  "nodes",
  "cron",
  "message",
  "tts",
  "gateway",
  "agents_list",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "session_status",
  "gog_auth_start",
  "gog_auth_status",
  "gog_auth_revoke",
  "gog_exec",
  "web_search",
  "web_fetch",
  "image",
  "architect_pipeline",
  "venture_studio",
  "knowledge_graph",
  "summarize",
];

/**
 * Maps tool IDs to factory-specific options derived from the master options bag.
 * Each factory has its own parameter names, so explicit mapping is required.
 */
function buildToolOptions(id: string, ctx: ToolContext): Record<string, unknown> | undefined {
  const opts = ctx.options;
  switch (id) {
    case "browser":
      return {
        sandboxBridgeUrl: opts?.sandboxBrowserBridgeUrl,
        allowHostControl: opts?.allowHostBrowserControl,
      };
    case "canvas":
      return { config: opts?.config };
    case "nodes":
      return { agentSessionKey: opts?.agentSessionKey, config: opts?.config };
    case "cron":
      return { agentSessionKey: opts?.agentSessionKey };
    case "message":
      return {
        agentAccountId: opts?.agentAccountId,
        agentSessionKey: opts?.agentSessionKey,
        config: opts?.config,
        currentChannelId: opts?.currentChannelId,
        currentChannelProvider: opts?.agentChannel,
        currentThreadTs: opts?.currentThreadTs,
        replyToMode: opts?.replyToMode,
        hasRepliedRef: opts?.hasRepliedRef,
        sandboxRoot: opts?.sandboxRoot,
        requireExplicitTarget: opts?.requireExplicitMessageTarget,
      };
    case "tts":
      return { agentChannel: opts?.agentChannel, config: opts?.config };
    case "gateway":
      return { agentSessionKey: opts?.agentSessionKey, config: opts?.config };
    case "agents_list":
      return {
        agentSessionKey: opts?.agentSessionKey,
        requesterAgentIdOverride: opts?.requesterAgentIdOverride,
      };
    case "sessions_list":
      return { agentSessionKey: opts?.agentSessionKey, sandboxed: opts?.sandboxed };
    case "sessions_history":
      return { agentSessionKey: opts?.agentSessionKey, sandboxed: opts?.sandboxed };
    case "sessions_send":
      return {
        agentSessionKey: opts?.agentSessionKey,
        agentChannel: opts?.agentChannel,
        sandboxed: opts?.sandboxed,
      };
    case "sessions_spawn":
      return {
        agentSessionKey: opts?.agentSessionKey,
        agentChannel: opts?.agentChannel,
        agentAccountId: opts?.agentAccountId,
        agentTo: opts?.agentTo,
        agentThreadId: opts?.agentThreadId,
        agentGroupId: opts?.agentGroupId,
        agentGroupChannel: opts?.agentGroupChannel,
        agentGroupSpace: opts?.agentGroupSpace,
        sandboxed: opts?.sandboxed,
        requesterAgentIdOverride: opts?.requesterAgentIdOverride,
      };
    case "subagents":
      return { agentSessionKey: opts?.agentSessionKey };
    case "session_status":
      return { agentSessionKey: opts?.agentSessionKey, config: opts?.config };
    case "gog_auth_start":
      return {
        agentId: ctx.agentId,
        agentDir: opts?.agentDir,
        sessionKey: opts?.agentSessionKey,
      };
    case "gog_auth_status":
      return { agentId: ctx.agentId, sessionKey: opts?.agentSessionKey };
    case "gog_auth_revoke":
      return {
        agentId: ctx.agentId,
        agentDir: opts?.agentDir,
        sessionKey: opts?.agentSessionKey,
      };
    case "gog_exec":
      return { agentId: ctx.agentId, sessionKey: opts?.agentSessionKey };
    case "web_search":
      return { config: opts?.config, sandboxed: opts?.sandboxed };
    case "web_fetch":
      return { config: opts?.config, sandboxed: opts?.sandboxed };
    case "image":
      return {
        config: opts?.config,
        agentDir: opts?.agentDir,
        workspaceDir: ctx.workspaceDir,
        sandbox:
          opts?.sandboxRoot && opts?.sandboxFsBridge
            ? { root: opts.sandboxRoot, bridge: opts.sandboxFsBridge }
            : undefined,
        modelHasVision: opts?.modelHasVision,
      };
    case "architect_pipeline":
      return { workspaceDir: ctx.workspaceDir };
    case "venture_studio":
      return { workspaceDir: ctx.workspaceDir };
    case "knowledge_graph":
      // KG factory takes a positional arg, not an options bag.
      // Handled specially in the main loop.
      return undefined;
    case "summarize":
      // No options.
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Evaluates condition predicates declared in tool metadata.
 */
function evaluateCondition(condition: string, ctx: ToolContext): boolean {
  switch (condition) {
    case "gogOAuthEnabled":
      return ctx.gogOAuthEnabled;
    case "hasAgentDir":
      return !!ctx.options?.agentDir?.trim();
    case "messageEnabled":
      return !ctx.options?.disableMessageTool;
    default:
      return true;
  }
}

export async function createOpenClawTools(
  options?: CreateOpenClawToolsOptions,
): Promise<AnyAgentTool[]> {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const agentId = resolveSessionAgentId({
    sessionKey: options?.agentSessionKey,
    config: options?.config,
  });
  let kgSession: KnowledgeGraphSession | undefined;
  try {
    kgSession = KnowledgeGraphSession.forAgent(agentId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`KG DB open failed for agent ${agentId}: ${String(err)}`);
  }
  const gogOAuthEnabled =
    options?.config?.hooks?.gogOAuth?.enabled !== false &&
    !isTruthyEnvValue(process.env.OPENCLAW_SKIP_GOG_OAUTH);

  const ctx: ToolContext = { options, workspaceDir, agentId, kgSession, gogOAuthEnabled };

  const tools: AnyAgentTool[] = [];

  for (const id of TOOL_ORDER) {
    const entry: ToolRegistryEntry | undefined = TOOL_REGISTRY[id];
    if (!entry) {
      continue;
    }

    // Check conditions
    if (entry.meta.condition && !evaluateCondition(entry.meta.condition, ctx)) {
      continue;
    }

    // Lazy-load the module
    const mod = await entry.load();
    const factory = mod[entry.meta.factory] as (...args: unknown[]) => unknown;
    if (!factory) {
      continue;
    }

    // Build options and call factory
    let result: unknown;
    if (id === "knowledge_graph") {
      // KG factory takes a positional KnowledgeGraphSession argument and agentId for namespace
      // enforcement (MIN-384: agent-scoped namespace prefix at tool layer).
      result = factory(ctx.kgSession, ctx.agentId);
    } else {
      const factoryOpts = buildToolOptions(id, ctx);
      result = factory(factoryOpts);
    }

    // Handle multi-tool factories and nullable results
    if (entry.meta.multi && Array.isArray(result)) {
      tools.push(...(result as AnyAgentTool[]));
    } else if (result) {
      tools.push(result as AnyAgentTool);
    }
  }

  // Plugin tools: unchanged
  const pluginTools = resolvePluginTools({
    context: {
      config: options?.config,
      workspaceDir,
      agentDir: options?.agentDir,
      agentId,
      sessionKey: options?.agentSessionKey,
      messageChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      sandboxed: options?.sandboxed,
    },
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    toolAllowlist: options?.pluginToolAllowlist,
  });

  return [...tools, ...pluginTools];
}
