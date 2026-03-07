/**
 * End-to-end OAuth flow test script.
 *
 * Usage:
 *   npx tsx scripts/test-oauth-flow.ts
 *
 * Requires: Google client credentials JSON at ~/.minion/google-client-credentials.json
 * (or pass path as first CLI arg).
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createGoogleAuthProvider } from "../src/auth/google/google-auth-provider.js";
import { updateSessionStore, resolveDefaultSessionStorePath } from "../src/config/sessions.js";
import { setGoogleClientCredentialsFile } from "../src/hooks/gog-credentials.js";
import {
  startGogOAuthServer,
  generateState,
  addPendingFlow,
  getRedirectUri,
} from "../src/hooks/gog-oauth-server.js";
import type { PendingOAuthFlow } from "../src/hooks/gog-oauth-types.js";

const EMAIL = "nikolas.pinon98@gmail.com";
const AGENT_ID = "test-oauth";
const SESSION_KEY = "test-session";

async function main() {
  const credFile =
    process.argv[2] || path.join(os.homedir(), ".minion", "google-client-credentials.json");

  if (!fs.existsSync(credFile)) {
    console.error(`Client credentials file not found: ${credFile}`);
    process.exit(1);
  }

  console.log(`Loading client credentials from ${credFile}`);
  setGoogleClientCredentialsFile(credFile);

  // Ensure agent dir exists for session store
  const agentDir = path.join(os.homedir(), ".minion", "agents", AGENT_ID);
  fs.mkdirSync(agentDir, { recursive: true });

  // Create a fake session entry so the notification handler can find routing info
  const storePath = resolveDefaultSessionStorePath(AGENT_ID);
  await updateSessionStore(storePath, (store) => {
    store[SESSION_KEY] = {
      sessionKey: SESSION_KEY,
      agentId: AGENT_ID,
      // Route notification to console (will fail delivery but we'll see the attempt)
      lastChannel: "whatsapp",
      lastTo: "+51922286663",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as unknown;
  });

  console.log("Starting OAuth server...");
  const { port, stop } = await startGogOAuthServer({}, agentDir);
  console.log(`OAuth server listening on port ${port}`);

  const provider = createGoogleAuthProvider();
  const state = generateState();
  const redirectUri = getRedirectUri();
  const now = Date.now();
  const expiresAt = now + 5 * 60 * 1000;

  const authUrl = provider.buildAuthUrl({
    email: EMAIL,
    services: ["gmail", "calendar", "drive"],
    redirectUri,
    state,
  });

  const flow: PendingOAuthFlow = {
    state,
    sessionKey: SESSION_KEY,
    agentId: AGENT_ID,
    email: EMAIL,
    services: ["gmail", "calendar", "drive"],
    requestedAt: now,
    expiresAt,
    authUrl,
  };

  addPendingFlow(flow);

  console.log("\n========================================");
  console.log("Open this URL in your browser to authenticate:");
  console.log("========================================\n");
  console.log(authUrl);
  console.log("\n========================================");
  console.log("Waiting for callback (5 minute timeout)...");
  console.log("Press Ctrl+C to abort.\n");

  // Keep alive until callback or timeout
  const timeout = setTimeout(
    async () => {
      console.log("Timeout reached. Stopping server.");
      await stop();
      process.exit(1);
    },
    5 * 60 * 1000,
  );

  // Watch for credential file creation as success signal
  const credDir = path.join(
    os.homedir(),
    ".minion",
    "agents",
    AGENT_ID,
    "auth-credentials",
    "google",
  );
  fs.mkdirSync(credDir, { recursive: true });

  const watcher = fs.watch(credDir, async (_event, filename) => {
    if (filename?.endsWith(".json")) {
      console.log(`\nCredentials stored: ${path.join(credDir, filename)}`);
      const data = JSON.parse(fs.readFileSync(path.join(credDir, filename), "utf-8"));
      console.log("Email:", data.email);
      console.log("Services:", data.services);
      console.log("Token expires at:", new Date(data.expiresAt).toLocaleString());
      console.log("Refresh token present:", !!data.refreshToken);

      // Give notifications a moment to fire
      await new Promise((r) => setTimeout(r, 3000));

      console.log("\nTest complete. Cleaning up...");
      watcher.close();
      clearTimeout(timeout);
      await stop();
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
