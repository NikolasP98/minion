import type { IncomingMessage, ServerResponse } from "node:http";
import type { MinionConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { createConfigIO } from "../config/io.js";
import { getHookEvents } from "./hooks-event-log.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export async function handleConfigApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://localhost`);

  if (!url.pathname.startsWith("/api/config")) {
    return false;
  }

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return true;
  }

  // GET /api/config/hooks/events - Return recent webhook event log
  if (req.method === "GET" && url.pathname === "/api/config/hooks/events") {
    sendJson(res, 200, { ok: true, events: getHookEvents() });
    return true;
  }

  // GET /api/config - Read current configuration
  if (req.method === "GET" && url.pathname === "/api/config") {
    try {
      const config = loadConfig();
      sendJson(res, 200, config);
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to load config",
      });
    }
    return true;
  }

  // PUT /api/config - Update configuration
  if (req.method === "PUT" && url.pathname === "/api/config") {
    try {
      const newConfig = (await readJsonBody(req)) as MinionConfig;

      // Write the config using the config IO
      const configIo = createConfigIO();
      await configIo.writeConfigFile(newConfig);

      sendJson(res, 200, {
        ok: true,
        message: "Configuration saved successfully",
      });
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to save config",
      });
    }
    return true;
  }

  return false;
}
