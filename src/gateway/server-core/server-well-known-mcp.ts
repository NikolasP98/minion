import type { IncomingMessage, ServerResponse } from "node:http";

const WELL_KNOWN_MCP_PATH = "/.well-known/mcp";

// Static package metadata — kept in sync with package.json via build process
const SERVER_CARD_NAME = "io.github.nikolasp98/minion";
const SERVER_CARD_TITLE = "Minion Gateway";
const SERVER_CARD_DESCRIPTION = "Multi-channel AI gateway with extensible messaging integrations";
const SERVER_CARD_VERSION = "2026.3.6";
const SERVER_CARD_WEBSITE_URL = "https://github.com/NikolasP98/minion#readme";
const SERVER_CARD_REPOSITORY = "https://github.com/NikolasP98/minion.git";

interface McpRemote {
  type: string;
  url: string;
  authentication: {
    required: boolean;
    schemes: string[];
  };
}

interface McpCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

interface McpServerCard {
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  repository: string;
  remotes: McpRemote[];
  capabilities: McpCapabilities;
}

function resolveIsSecure(req: IncomingMessage): boolean {
  const proto = req.headers["x-forwarded-proto"];
  if (typeof proto === "string" && proto.toLowerCase() === "https") {
    return true;
  }
  // Native TLS: the socket has an 'encrypted' property when TLS is active
  const socket = req.socket as { encrypted?: boolean } | null;
  return Boolean(socket?.encrypted);
}

function buildServerCard(host: string, isSecure: boolean): McpServerCard {
  const wsScheme = isSecure ? "wss" : "ws";
  return {
    name: SERVER_CARD_NAME,
    title: SERVER_CARD_TITLE,
    description: SERVER_CARD_DESCRIPTION,
    version: SERVER_CARD_VERSION,
    websiteUrl: SERVER_CARD_WEBSITE_URL,
    repository: SERVER_CARD_REPOSITORY,
    remotes: [
      {
        type: "ws",
        url: `${wsScheme}://${host}/`,
        authentication: { required: true, schemes: ["bearer"] },
      },
    ],
    capabilities: { tools: true, resources: true, prompts: false },
  };
}

/**
 * Handles GET /.well-known/mcp — returns MCP Server Card for registry discovery.
 * Unauthenticated. Always sets CORS headers for cross-origin registry crawlers.
 * Returns false if the request path does not match.
 */
export function handleWellKnownMcpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== WELL_KNOWN_MCP_PATH) {
    return false;
  }

  // CORS: registries and crawlers may request from any origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, OPTIONS");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const host = typeof req.headers.host === "string" ? req.headers.host : "localhost";
  const card = buildServerCard(host, resolveIsSecure(req));

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(JSON.stringify(card));
  return true;
}
