/**
 * Tool name resolver — maps LLM tool call names to handler identifiers.
 *
 * Fully stateless: no DB, no file I/O, no Node.js-only APIs.
 * Suitable for deployment as a Cloudflare Worker V8 Isolate.
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ToolHandler =
  | "bash"
  | "read_file"
  | "write_file"
  | "memory_search"
  | "memory_get"
  | "web_search"
  | "web_fetch"
  | "image_generate"
  | "code_execute"
  | "unknown";

export type ToolRouteResult = {
  handler: ToolHandler;
  /** Resolved canonical name used internally. */
  canonicalName: string;
  /** Whether this tool requires elevated sandbox permissions. */
  requiresSandbox: boolean;
  /** Whether this tool makes network calls. */
  isNetworkTool: boolean;
};

// ── Route table ───────────────────────────────────────────────────────────────

/**
 * Canonical-name aliases — maps any variant LLMs might emit to the handler key.
 * All keys lower-cased for case-insensitive lookup.
 */
const TOOL_ALIASES: Record<string, ToolHandler> = {
  // Bash / shell
  bash: "bash",
  shell: "bash",
  run_bash: "bash",
  execute_bash: "bash",
  run_command: "bash",
  computer: "bash",

  // File read
  read_file: "read_file",
  readfile: "read_file",
  view: "read_file",
  cat: "read_file",

  // File write
  write_file: "write_file",
  writefile: "write_file",
  edit: "write_file",
  create_file: "write_file",
  str_replace_editor: "write_file",
  str_replace_based_edit_tool: "write_file",

  // Memory
  memory_search: "memory_search",
  memorysearch: "memory_search",
  search_memory: "memory_search",
  memory_get: "memory_get",
  memoryget: "memory_get",

  // Web
  web_search: "web_search",
  websearch: "web_search",
  search: "web_search",
  tavily_search: "web_search",
  web_fetch: "web_fetch",
  webfetch: "web_fetch",
  fetch: "web_fetch",
  http_request: "web_fetch",

  // Image generation
  image_generate: "image_generate",
  generate_image: "image_generate",
  create_image: "image_generate",
  dalle: "image_generate",
  flux: "image_generate",

  // Code execution
  code_execute: "code_execute",
  execute_code: "code_execute",
  run_code: "code_execute",
  python: "code_execute",
  jupyter_execute: "code_execute",
};

const HANDLER_META: Record<ToolHandler, { requiresSandbox: boolean; isNetworkTool: boolean }> = {
  bash: { requiresSandbox: true, isNetworkTool: false },
  read_file: { requiresSandbox: false, isNetworkTool: false },
  write_file: { requiresSandbox: false, isNetworkTool: false },
  memory_search: { requiresSandbox: false, isNetworkTool: false },
  memory_get: { requiresSandbox: false, isNetworkTool: false },
  web_search: { requiresSandbox: false, isNetworkTool: true },
  web_fetch: { requiresSandbox: false, isNetworkTool: true },
  image_generate: { requiresSandbox: false, isNetworkTool: true },
  code_execute: { requiresSandbox: true, isNetworkTool: false },
  unknown: { requiresSandbox: false, isNetworkTool: false },
};

// ── Router ───────────────────────────────────────────────────────────────────

/**
 * Resolve an LLM-emitted tool call name to a handler and metadata.
 *
 * Lookup is O(1) map access — suitable for hot-path execution inside a Worker.
 */
export function routeTool(toolName: string): ToolRouteResult {
  const normalized = toolName.trim().toLowerCase();
  const handler = TOOL_ALIASES[normalized] ?? "unknown";
  const meta = HANDLER_META[handler];
  return {
    handler,
    canonicalName: normalized,
    requiresSandbox: meta.requiresSandbox,
    isNetworkTool: meta.isNetworkTool,
  };
}

/**
 * Batch resolve a list of tool names.
 */
export function routeTools(toolNames: string[]): ToolRouteResult[] {
  return toolNames.map(routeTool);
}
