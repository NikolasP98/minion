import { syncGoogleCredentialsToAuthStore } from "../../agents/auth-profiles/google-credential-bridge.js";
import { startRefreshScheduler } from "../../agents/auth-profiles/refresh-scheduler.js";
import { runStartupCredentialCheck } from "../../agents/auth-profiles/startup-check.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { loadModelCatalog } from "../../agents/models/model-catalog.js";
import {
  getModelRefStatus,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "../../agents/models/model-selection.js";
import { resolveAgentSessionDirs } from "../../agents/sessions/session-dirs.js";
import { cleanStaleLockFiles } from "../../agents/sessions/session-write-lock.js";
import type { CliDeps } from "../../cli/deps.js";
import type { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { startGmailWatcherWithLogs } from "../../hooks/gmail-watcher-lifecycle.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../../hooks/internal-hooks.js";
import { loadInternalHooks } from "../../hooks/loader.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { pruneOldTraceFiles } from "../../logging/chat-trace.js";
import type { loadOpenClawPlugins } from "../../plugins/loader.js";
import { type PluginServicesHandle, startPluginServices } from "../../plugins/services.js";
import { runModelHealthChecks } from "../model-health-check.js";
import { startBrowserControlServerIfEnabled } from "./server-browser.js";
import {
  scheduleRestartSentinelWake,
  shouldWakeFromRestartSentinel,
} from "./server-restart-sentinel.js";
import { startGatewayMemoryBackend } from "./server-startup-memory.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;

export async function startGatewaySidecars(params: {
  cfg: ReturnType<typeof loadConfig>;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  logBrowser: { error: (msg: string) => void };
}) {
  // --- Phase 1: Independent startup tasks (parallelized) ---
  const sessionLockCleanup = (async () => {
    try {
      const stateDir = resolveStateDir(process.env);
      const sessionDirs = await resolveAgentSessionDirs(stateDir);
      for (const sessionsDir of sessionDirs) {
        await cleanStaleLockFiles({
          sessionsDir,
          staleMs: SESSION_LOCK_STALE_MS,
          removeStale: true,
          log: { warn: (message) => params.log.warn(message) },
        });
      }
    } catch (err) {
      params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
    }
  })();

  // Prune old chat trace files (best-effort).
  pruneOldTraceFiles();

  const credentialSync = (async () => {
    // Bridge Google credentials into auth-profiles (Phase 1 — non-breaking).
    try {
      await syncGoogleCredentialsToAuthStore();
    } catch (err) {
      params.log.warn(`Google credential bridge failed: ${String(err)}`);
    }
  })();

  // Validate credential health on startup and start proactive refresh scheduler.
  runStartupCredentialCheck({ cfg: params.cfg });
  const refreshScheduler = startRefreshScheduler();

  const browserControlTask = (async () => {
    try {
      return await startBrowserControlServerIfEnabled();
    } catch (err) {
      params.logBrowser.error(`server failed to start: ${String(err)}`);
      return null;
    }
  })();

  const gogOAuthTask = (async () => {
    if (
      params.cfg.hooks?.gogOAuth?.enabled !== false &&
      !isTruthyEnvValue(process.env.OPENCLAW_SKIP_GOG_OAUTH)
    ) {
      try {
        const { startGogOAuthServer } = await import("../../hooks/gog-oauth-server.js");
        const server = await startGogOAuthServer(
          params.cfg.hooks?.gogOAuth || {},
          params.defaultWorkspaceDir,
        );
        params.logHooks.info("google oauth server started");
        return server;
      } catch (err) {
        params.logHooks.error(`google oauth server failed to start: ${String(err)}`);
      }
    }
    return null;
  })();

  const gmailWatcherTask = startGmailWatcherWithLogs({
    cfg: params.cfg,
    log: params.logHooks,
  });

  // Wait for all independent startup tasks to complete.
  const [, , browserControl, gogOAuthServer] = await Promise.all([
    sessionLockCleanup,
    credentialSync,
    browserControlTask,
    gogOAuthTask,
    gmailWatcherTask,
  ]);

  // Validate hooks.gmail.model if configured.
  if (params.cfg.hooks?.gmail?.model) {
    const hooksModelRef = resolveHooksGmailModel({
      cfg: params.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (hooksModelRef) {
      const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const catalog = await loadModelCatalog({ config: params.cfg });
      const status = getModelRefStatus({
        cfg: params.cfg,
        catalog,
        ref: hooksModelRef,
        defaultProvider,
        defaultModel,
      });
      if (!status.allowed) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
        );
      }
      if (!status.inCatalog) {
        params.logHooks.warn(
          `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
        );
      }
    }
  }

  // Load internal hook handlers from configuration and directory discovery.
  try {
    // Clear any previously registered hooks to ensure fresh loading
    clearInternalHooks();
    const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
    if (loadedCount > 0) {
      params.logHooks.info(
        `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
      );
    }
  } catch (err) {
    params.logHooks.error(`failed to load hooks: ${String(err)}`);
  }

  // Run health checks for locally configured models (smart routing).
  // Non-blocking: logs warnings but never prevents gateway from starting.
  void runModelHealthChecks({
    routing: params.cfg.agents?.defaults?.routing,
    log: {
      info: (msg: string) => params.logChannels.info(`[model-health] ${msg}`),
      warn: (msg: string) => params.log.warn(`[model-health] ${msg}`),
    },
  }).catch((err) => {
    params.log.warn(`model health check failed: ${String(err)}`);
  });

  // Launch configured channels so gateway replies via the surface the message came from.
  // Tests can opt out via OPENCLAW_SKIP_CHANNELS (or legacy OPENCLAW_SKIP_PROVIDERS).
  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  if (!skipChannels) {
    try {
      await params.startChannels();
    } catch (err) {
      params.logChannels.error(`channel startup failed: ${String(err)}`);
    }
  } else {
    params.logChannels.info(
      "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
  }

  if (params.cfg.hooks?.internal?.enabled) {
    setTimeout(() => {
      const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
        cfg: params.cfg,
        deps: params.deps,
        workspaceDir: params.defaultWorkspaceDir,
      });
      void triggerInternalHook(hookEvent);
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  try {
    pluginServices = await startPluginServices({
      registry: params.pluginRegistry,
      config: params.cfg,
      workspaceDir: params.defaultWorkspaceDir,
    });
  } catch (err) {
    params.log.warn(`plugin services failed to start: ${String(err)}`);
  }

  void startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }).catch((err) => {
    params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
  });

  if (shouldWakeFromRestartSentinel()) {
    setTimeout(() => {
      void scheduleRestartSentinelWake({ deps: params.deps });
    }, 750);
  }

  return { browserControl, pluginServices, gogOAuthServer, refreshScheduler };
}
