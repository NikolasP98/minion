/**
 * parse_screen tool — proxies to the OmniParser-v2 microservice to detect
 * and label interactive UI elements in a screenshot.
 *
 * Service URL resolution order:
 *   1. opts.omniparserUrl
 *   2. config.gateway?.omniparserUrl  (OpenClawConfig extension point)
 *   3. OMNIPARSER_URL env var
 *
 * Returns null (disabled) when no URL is configured so the tool is silently
 * excluded from the active tool set.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { wrapToolWithTracking } from "../../logging/tool-tracking.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, readStringParam } from "./common.js";

const DETAIL_LEVELS = ["low", "high"] as const;

const ParseScreenSchema = Type.Object({
  screenshot: Type.String({
    description: "Base64-encoded PNG or JPEG screenshot to analyse.",
  }),
  detail_level: Type.Optional(
    stringEnum(DETAIL_LEVELS, {
      description: 'Detection sensitivity: "high" finds more elements, "low" is faster.',
      default: "high",
    }),
  ),
});

type OmniParserElement = {
  id: number;
  label: string;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] normalised 0–1
  type: string;
  clickable: boolean;
};

type OmniParserResponse = {
  labeled_screenshot: string;
  elements: OmniParserElement[];
};

function resolveServiceUrl(opts: {
  omniparserUrl?: string;
  config?: OpenClawConfig;
}): string | null {
  if (opts.omniparserUrl) {
    return opts.omniparserUrl;
  }
  const cfgUrl = (opts.config ?? loadConfig())?.gateway?.omniparserUrl as string | undefined;
  if (cfgUrl) {
    return cfgUrl;
  }
  return process.env.OMNIPARSER_URL ?? null;
}

export function createParseScreenTool(opts: {
  omniparserUrl?: string;
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
    label: "Parse Screen",
    name: "parse_screen",
    description:
      "Analyse a screenshot to identify and label interactive UI elements. " +
      "Returns a labeled screenshot (base64 PNG) and an element manifest suitable for UI automation.",
    parameters: ParseScreenSchema,
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const screenshot = readStringParam(args, "screenshot", { required: true });
      const detailLevel =
        (readStringParam(args, "detail_level") as (typeof DETAIL_LEVELS)[number] | undefined) ??
        "high";

      const endpoint = `${serviceUrl}/parse`;
      let res: Response;
      try {
        res = await fetchFn(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ screenshot, detail_level: detailLevel }),
        });
      } catch (err) {
        throw new Error(
          `OmniParser service unreachable at ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
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
        throw new Error(`OmniParser service error ${res.status}${detail ? `: ${detail}` : ""}`);
      }

      const data = (await res.json()) as OmniParserResponse;
      const count = data.elements.length;
      const clickable = data.elements.filter((e) => e.clickable).length;

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Detected ${count} UI element${count !== 1 ? "s" : ""} ` +
              `(${clickable} clickable). Labeled screenshot and element manifest returned.`,
          },
        ],
        details: {
          labeled_screenshot: data.labeled_screenshot,
          elements: data.elements,
        },
      };
    },
  };

  return wrapToolWithTracking(tool, "parse_screen");
}
