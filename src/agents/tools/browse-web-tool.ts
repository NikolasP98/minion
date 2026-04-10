/**
 * browse_web tool — proxies to the BrowserUse microservice to execute
 * LLM-directed headless browser tasks.
 *
 * Service URL resolution order:
 *   1. opts.browseuseUrl
 *   2. config.gateway?.browseuseUrl  (OpenClawConfig extension point)
 *   3. BROWSERUSE_URL env var
 *
 * Returns null (disabled) when no URL is configured so the tool is silently
 * excluded from the active tool set.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { wrapToolWithTracking } from "../../logging/tool-tracking.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

const BrowseWebSchema = Type.Object({
  task: Type.String({
    description:
      "The browser task to complete (e.g. 'Find the pricing page and return the plan names').",
  }),
  url_hint: Type.Optional(
    Type.String({
      description: "Optional starting URL or domain to navigate to before beginning the task.",
    }),
  ),
  max_steps: Type.Optional(
    Type.Integer({
      description: "Maximum number of browser interaction steps. Default 10, maximum 10.",
      default: 10,
      maximum: 10,
    }),
  ),
  timeout_seconds: Type.Optional(
    Type.Integer({
      description: "Hard timeout in seconds. Default 30, maximum 30.",
      default: 30,
      maximum: 30,
    }),
  ),
});

type BrowseStep = {
  step: number;
  action: string;
  url: string;
};

type BrowseWebResponse = {
  success: boolean;
  final_url: string;
  content: string;
  screenshot: string;
  steps: BrowseStep[];
  error?: string;
};

function resolveServiceUrl(opts: {
  browseuseUrl?: string;
  config?: OpenClawConfig;
}): string | null {
  if (opts.browseuseUrl) {
    return opts.browseuseUrl;
  }
  const cfgUrl = (opts.config ?? loadConfig())?.gateway?.browseuseUrl;
  if (cfgUrl) {
    return cfgUrl;
  }
  return process.env.BROWSERUSE_URL ?? null;
}

export function createBrowseWebTool(opts: {
  browseuseUrl?: string;
  config?: OpenClawConfig;
  /** Injected fetch for testing. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}): AnyAgentTool | null {
  const serviceUrl = resolveServiceUrl(opts);
  if (!serviceUrl) {
    return null;
  }

  const fetchFn = opts.fetchFn ?? fetch;

  const tool: AnyAgentTool = {
    label: "Browse Web",
    name: "browse_web",
    description:
      "Use a headless browser to complete a web-based research or interaction task. " +
      "Returns the final page URL, extracted content, a base64 PNG screenshot, and an action log. " +
      "Internal/private hosts are blocked for security.",
    parameters: BrowseWebSchema,
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const task = readStringParam(args, "task", { required: true });
      const urlHint = readStringParam(args, "url_hint") ?? undefined;
      const maxSteps = typeof args.max_steps === "number" ? args.max_steps : undefined;
      const timeoutSeconds =
        typeof args.timeout_seconds === "number" ? args.timeout_seconds : undefined;

      const endpoint = `${serviceUrl}/browse`;
      let res: Response;
      try {
        res = await fetchFn(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task,
            url_hint: urlHint,
            max_steps: maxSteps,
            timeout_seconds: timeoutSeconds,
          }),
        });
      } catch (err) {
        throw new Error(
          `BrowserUse service unreachable at ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      if (!res.ok) {
        let detail = "";
        try {
          const body = (await res.json()) as { detail?: string };
          detail = body.detail ?? "";
        } catch {
          // ignore JSON parse errors on error responses
        }
        throw new Error(`BrowserUse service error ${res.status}${detail ? `: ${detail}` : ""}`);
      }

      const data = (await res.json()) as BrowseWebResponse;
      const stepCount = data.steps.length;
      const statusWord = data.success ? "completed" : "failed";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Browser task ${statusWord} in ${stepCount} step${stepCount !== 1 ? "s" : ""}. ` +
              `Final URL: ${data.final_url || "(none)"}` +
              (data.error ? `. Error: ${data.error}` : ""),
          },
        ],
        details: {
          success: data.success,
          final_url: data.final_url,
          content: data.content,
          screenshot: data.screenshot,
          steps: data.steps,
          error: data.error,
        },
      };
    },
  };

  return wrapToolWithTracking(tool, "browse_web");
}
