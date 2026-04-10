/**
 * LLM gateway — routes LLM calls through Cloudflare AI Gateway when configured.
 *
 * When CF_AI_GATEWAY_URL is set, all provider calls are proxied through:
 *   - Semantic caching (cache identical prompts by hash)
 *   - Provider fallback: OpenAI primary → Anthropic fallback
 *   - Rate limiting: 1000 req/min per workspace
 *
 * Falls back to direct provider endpoints when the env var is absent.
 *
 * @module
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type LLMProvider = "openai" | "anthropic";

export type GatewayRequestOptions = {
  provider: LLMProvider;
  /**
   * Path segment appended to the provider base URL.
   * e.g. "/v1/chat/completions" or "/v1/messages"
   */
  path: string;
  body: unknown;
  headers?: Record<string, string>;
  /** Workspace identifier used as the rate-limit key. */
  workspaceId?: string;
  /** Whether to allow fallback to the secondary provider on 5xx. */
  allowFallback?: boolean;
};

export type GatewayResponse = {
  ok: boolean;
  status: number;
  provider: LLMProvider;
  /** Whether the response came from CF cache. */
  cached: boolean;
  data: unknown;
};

// ── Provider base URLs ────────────────────────────────────────────────────────

const PROVIDER_BASE_URLS: Record<LLMProvider, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};

const FALLBACK_ORDER: Record<LLMProvider, LLMProvider> = {
  openai: "anthropic",
  anthropic: "openai",
};

// ── Gateway URL resolution ────────────────────────────────────────────────────

/**
 * Resolve the effective base URL for a provider.
 *
 * When CF_AI_GATEWAY_URL is set, the gateway URL is:
 *   {CF_AI_GATEWAY_URL}/{provider}{path}
 *
 * The Cloudflare AI Gateway URL format is:
 *   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{provider}
 */
function resolveProviderUrl(
  provider: LLMProvider,
  path: string,
  cfGatewayUrl: string | undefined,
): string {
  if (cfGatewayUrl) {
    const base = cfGatewayUrl.replace(/\/$/, "");
    return `${base}/${provider}${path}`;
  }
  return `${PROVIDER_BASE_URLS[provider]}${path}`;
}

// ── Gateway client ────────────────────────────────────────────────────────────

function buildProviderHeaders(
  provider: LLMProvider,
  workspaceId: string | undefined,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const envVarName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const apiKey = (typeof process !== "undefined" ? process.env[envVarName] : undefined) ?? "";

  if (!apiKey) {
    // Warn clearly rather than silently sending requests that will fail with 401.
    console.warn(
      `[llm-gateway] ${envVarName} is not set; requests to ${provider} will fail with 401`,
    );
  }

  const base: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  if (provider === "openai") {
    base["Authorization"] = `Bearer ${apiKey}`;
  } else {
    base["x-api-key"] = apiKey;
    base["anthropic-version"] = "2023-06-01";
  }

  if (workspaceId) {
    // CF AI Gateway uses this header for per-workspace rate limiting.
    base["cf-aig-customer-id"] = workspaceId;
  }

  return base;
}

async function doRequest(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: unknown; cached: boolean }> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const cached = res.headers.get("cf-aig-cache-status") === "HIT";
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = await res.text().catch(() => null);
  }

  return { ok: res.ok, status: res.status, data, cached };
}

/**
 * Send a request through the LLM gateway.
 *
 * Reads CF_AI_GATEWAY_URL from environment. When set, routes through
 * Cloudflare AI Gateway for caching, fallback, and rate limiting.
 */
export async function gatewayRequest(opts: GatewayRequestOptions): Promise<GatewayResponse> {
  const cfGatewayUrl = typeof process !== "undefined" ? process.env.CF_AI_GATEWAY_URL : undefined;

  const { provider, path, body, headers: extraHeaders, workspaceId, allowFallback = true } = opts;

  const url = resolveProviderUrl(provider, path, cfGatewayUrl);
  const headers = buildProviderHeaders(provider, workspaceId, extraHeaders);

  const result = await doRequest(url, headers, body);

  if (!result.ok && result.status >= 500 && allowFallback && cfGatewayUrl) {
    // Provider-level 5xx: attempt fallback through CF AI Gateway.
    const fallbackProvider = FALLBACK_ORDER[provider];
    const fallbackUrl = resolveProviderUrl(fallbackProvider, path, cfGatewayUrl);
    const fallbackHeaders = buildProviderHeaders(fallbackProvider, workspaceId, extraHeaders);
    const fallbackResult = await doRequest(fallbackUrl, fallbackHeaders, body);
    return {
      ok: fallbackResult.ok,
      status: fallbackResult.status,
      provider: fallbackProvider,
      cached: fallbackResult.cached,
      data: fallbackResult.data,
    };
  }

  return {
    ok: result.ok,
    status: result.status,
    provider,
    cached: result.cached,
    data: result.data,
  };
}

/**
 * Convenience: POST to OpenAI chat completions (with fallback to Anthropic).
 */
export async function chatCompletion(
  body: unknown,
  workspaceId?: string,
): Promise<GatewayResponse> {
  return gatewayRequest({
    provider: "openai",
    path: "/v1/chat/completions",
    body,
    workspaceId,
    allowFallback: true,
  });
}

/**
 * Convenience: POST to Anthropic messages (with fallback to OpenAI).
 */
export async function anthropicMessages(
  body: unknown,
  workspaceId?: string,
): Promise<GatewayResponse> {
  return gatewayRequest({
    provider: "anthropic",
    path: "/v1/messages",
    body,
    workspaceId,
    allowFallback: true,
  });
}
