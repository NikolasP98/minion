/**
 * Test OAuth flow via protopi gateway WebSocket.
 *
 * Usage: npx tsx scripts/test-oauth-via-gateway.ts
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const GATEWAY_URL = "wss://protopi.donkey-agama.ts.net";
const TOKEN = "502c5a92f4999c7e95457a16c5791e1ffbad84132eafb29acc816271472166d2";
const _AGENT_ID = "panik";
const SESSION_KEY = "test-oauth-local";

function sendReq(ws: WebSocket, method: string, params?: unknown): string {
  const id = randomUUID();
  const frame = { type: "req", id, method, params };
  console.log(`[SEND] ${method}`);
  ws.send(JSON.stringify(frame));
  return id;
}

async function main() {
  console.log(`Connecting to ${GATEWAY_URL}...`);

  const ws = new WebSocket(GATEWAY_URL, {
    headers: { Origin: "http://localhost:5173" },
  });

  ws.on("open", () => {
    console.log("WebSocket open. Sending connect...\n");
    sendReq(ws, "connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "minion-control-ui",
        version: "1.0.0",
        platform: "linux",
        mode: "ui",
      },
      auth: {
        token: TOKEN,
      },
      scopes: ["operator.write", "operator.read", "chat.write", "chat.read"],
    });
  });

  ws.on("message", (data: Buffer) => {
    const text = String(data);
    try {
      const msg = JSON.parse(text);
      const type = msg.type;

      // Response frame
      if (type === "res") {
        if (msg.payload?.type === "hello-ok") {
          console.log(`[Connected] server=${msg.payload.server?.version}\n`);
          sendReq(ws, "chat.send", {
            sessionKey: SESSION_KEY,
            idempotencyKey: randomUUID(),
            message:
              "Use gog_auth_start to authenticate nikolas.pinon98@gmail.com with gmail, calendar, drive. Return ONLY the raw auth URL.",
          });
          return;
        }
        if (!msg.ok && msg.error) {
          console.error(`[Error] ${msg.error.message || JSON.stringify(msg.error)}`);
          return;
        }
        if (msg.payload) {
          console.log(`[Res] ${JSON.stringify(msg.payload).slice(0, 300)}`);
        }
        return;
      }

      // Event frame
      if (type === "event" || type === "evt") {
        const event = msg.event;
        const p = msg.payload ?? msg.params ?? {};

        if (event === "chat.delta" || event === "chat.chunk") {
          const delta = p.delta ?? p.text ?? "";
          if (delta) {
            process.stdout.write(delta);
            if (delta.includes("accounts.google.com")) {
              // Will be printed inline
            }
          }
          return;
        }

        if (event?.includes("tool")) {
          const name = p.name ?? p.toolName ?? "?";
          const result = p.result ?? p.output;
          if (result) {
            const str = typeof result === "string" ? result : JSON.stringify(result);
            console.log(`\n[Tool:${name}] ${str.slice(0, 600)}`);
            const urlMatch = str.match(/https:\/\/accounts\.google\.com[^\s"\\]+/);
            if (urlMatch) {
              console.log(`\n${"=".repeat(60)}`);
              console.log("AUTH URL:");
              console.log(`${"=".repeat(60)}\n`);
              console.log(urlMatch[0]);
              console.log(`\n${"=".repeat(60)}`);
              console.log("Open in browser. Callback routes to protopi.");
              console.log(`${"=".repeat(60)}\n`);
            }
          } else {
            console.log(`\n[Tool:${name}] calling...`);
          }
          return;
        }

        if (event === "chat.end" || event === "chat.done") {
          console.log("\n\n[Chat complete]");
          setTimeout(() => {
            ws.close();
            process.exit(0);
          }, 2000);
          return;
        }

        // Skip noisy
        if (
          ["tick", "presence", "typing", "status", "thinking", "challenge"].some((e) =>
            event?.includes(e),
          )
        ) {
          return;
        }

        console.log(`[${event}] ${JSON.stringify(p).slice(0, 200)}`);
        return;
      }

      console.log(`[?:${type}] ${text.slice(0, 300)}`);
    } catch {
      console.log(`[Raw] ${text.slice(0, 200)}`);
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    process.exit(1);
  });

  ws.on("close", (code, reason: Buffer) => {
    console.log(`\nClosed: ${code} ${String(reason)}`);
    process.exit(0);
  });

  setTimeout(() => {
    console.log("\nTimeout.");
    ws.close();
    process.exit(0);
  }, 180_000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
