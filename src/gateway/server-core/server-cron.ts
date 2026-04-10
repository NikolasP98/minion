import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
} from "../../config/sessions.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { runHeartbeatOnce } from "../../infra/heartbeat-runner.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { getChildLogger } from "../../logging.js";
import { emitReliabilityEvent } from "../../logging/reliability.js";
import { runCronIsolatedAgentTurn } from "../../platform/cron/isolated-agent.js";
import { appendCronRunLog, resolveCronRunLogPath } from "../../platform/cron/run-log.js";
import { CronService } from "../../platform/cron/service.js";
import { resolveCronStorePath } from "../../platform/cron/store.js";
import { normalizeHttpWebhookUrl } from "../../platform/cron/webhook-url.js";
import { normalizeAgentId, toAgentStoreSessionKey } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";

export type GatewayCronState = {
  cron: CronService;
  storePath: string;
  cronEnabled: boolean;
};

const CRON_WEBHOOK_TIMEOUT_MS = 10_000;

function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-webhook-url>";
  }
}

type CronWebhookTarget = {
  url: string;
  source: "delivery" | "legacy";
};

function resolveCronWebhookTarget(params: {
  delivery?: { mode?: string; to?: string };
  legacyNotify?: boolean;
  legacyWebhook?: string;
}): CronWebhookTarget | null {
  const mode = params.delivery?.mode?.trim().toLowerCase();
  if (mode === "webhook") {
    const url = normalizeHttpWebhookUrl(params.delivery?.to);
    return url ? { url, source: "delivery" } : null;
  }

  if (params.legacyNotify) {
    const legacyUrl = normalizeHttpWebhookUrl(params.legacyWebhook);
    if (legacyUrl) {
      return { url: legacyUrl, source: "legacy" };
    }
  }

  return null;
}

export function buildGatewayCronService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewayCronState {
  const cronLogger = getChildLogger({ module: "cron" });
  const storePath = resolveCronStorePath(params.cfg.cron?.store);
  const cronEnabled = process.env.MINION_SKIP_CRON !== "1" && params.cfg.cron?.enabled !== false;

  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = loadConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const hasAgent =
      normalized !== undefined &&
      Array.isArray(runtimeConfig.agents?.list) &&
      runtimeConfig.agents.list.some(
        (entry) =>
          entry && typeof entry.id === "string" && normalizeAgentId(entry.id) === normalized,
      );
    const agentId = hasAgent ? normalized : resolveDefaultAgentId(runtimeConfig);
    return { agentId, cfg: runtimeConfig };
  };

  const resolveCronSessionKey = (params: {
    runtimeConfig: ReturnType<typeof loadConfig>;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = params.requestedSessionKey?.trim();
    if (!requested) {
      return resolveAgentMainSessionKey({
        cfg: params.runtimeConfig,
        agentId: params.agentId,
      });
    }
    const candidate = toAgentStoreSessionKey({
      agentId: params.agentId,
      requestKey: requested,
      mainKey: params.runtimeConfig.session?.mainKey,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.runtimeConfig,
      agentId: params.agentId,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(params.agentId)) {
        return resolveAgentMainSessionKey({
          cfg: params.runtimeConfig,
          agentId: params.agentId,
        });
      }
    }
    return canonical;
  };

  const resolveCronWakeTarget = (opts?: { agentId?: string; sessionKey?: string | null }) => {
    const runtimeConfig = loadConfig();
    const requestedAgentId = opts?.agentId ? resolveCronAgent(opts.agentId).agentId : undefined;
    const derivedAgentId =
      requestedAgentId ??
      (opts?.sessionKey
        ? normalizeAgentId(resolveAgentIdFromSessionKey(opts.sessionKey))
        : undefined);
    const agentId = derivedAgentId || undefined;
    const sessionKey =
      opts?.sessionKey && agentId
        ? resolveCronSessionKey({
            runtimeConfig,
            agentId,
            requestedSessionKey: opts.sessionKey,
          })
        : undefined;
    return { runtimeConfig, agentId, sessionKey };
  };

  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const resolveSessionStorePath = (agentId?: string) =>
    resolveStorePath(params.cfg.session?.store, {
      agentId: agentId ?? defaultAgentId,
    });
  const sessionStorePath = resolveSessionStorePath(defaultAgentId);
  const warnedLegacyWebhookJobs = new Set<string>();

  const cron = new CronService({
    storePath,
    cronEnabled,
    cronConfig: params.cfg.cron,
    defaultAgentId,
    resolveSessionStorePath,
    sessionStorePath,
    enqueueSystemEvent: (text, opts) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(opts?.agentId);
      const sessionKey = resolveCronSessionKey({
        runtimeConfig,
        agentId,
        requestedSessionKey: opts?.sessionKey,
      });
      enqueueSystemEvent(text, { sessionKey, contextKey: opts?.contextKey });
    },
    requestHeartbeatNow: (opts) => {
      const { agentId, sessionKey } = resolveCronWakeTarget(opts);
      requestHeartbeatNow({
        reason: opts?.reason,
        agentId,
        sessionKey,
      });
    },
    runHeartbeatOnce: async (opts) => {
      const { runtimeConfig, agentId, sessionKey } = resolveCronWakeTarget(opts);
      return await runHeartbeatOnce({
        cfg: runtimeConfig,
        reason: opts?.reason,
        agentId,
        sessionKey,
        deps: { ...params.deps, runtime: defaultRuntime },
      });
    },
    runIsolatedAgentJob: async ({ job, message }) => {
      const { agentId, cfg: runtimeConfig } = resolveCronAgent(job.agentId);
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps: params.deps,
        job,
        message,
        agentId,
        sessionKey: `cron:${job.id}`,
        lane: "cron",
      });
    },
    log: getChildLogger({ module: "cron", storePath }),
    onEvent: (evt) => {
      params.broadcast("cron", evt, { dropIfSlow: true });

      // Emit reliability events for cron outcomes
      if (evt.action === "finished") {
        if (evt.status === "ok") {
          emitReliabilityEvent({
            category: "cron",
            severity: "low",
            event: "cron.run.ok",
            message: `Cron job ${evt.jobId} completed successfully`,
            sessionKey: evt.sessionKey,
            metadata: { jobId: evt.jobId, durationMs: evt.durationMs },
          });
        } else if (evt.status === "error") {
          emitReliabilityEvent({
            category: "cron",
            severity: "high",
            event: "cron.run.error",
            message: `Cron job ${evt.jobId} failed: ${evt.error ?? "unknown error"}`,
            sessionKey: evt.sessionKey,
            metadata: { jobId: evt.jobId, error: evt.error, durationMs: evt.durationMs },
          });
        } else if (evt.status === "skipped") {
          emitReliabilityEvent({
            category: "cron",
            severity: "medium",
            event: "cron.run.skipped",
            message: `Cron job ${evt.jobId} was skipped`,
            sessionKey: evt.sessionKey,
            metadata: { jobId: evt.jobId },
          });
        }
        // Detect late runs
        if (evt.runAtMs) {
          const latenessMs = Date.now() - evt.runAtMs - (evt.durationMs ?? 0);
          if (latenessMs > 60_000) {
            emitReliabilityEvent({
              category: "cron",
              severity: "medium",
              event: "cron.run.late",
              message: `Cron job ${evt.jobId} started ${Math.round(latenessMs / 1000)}s late`,
              sessionKey: evt.sessionKey,
              metadata: { jobId: evt.jobId, latenessMs },
            });
          }
        }
      }

      if (evt.action === "finished") {
        const webhookToken = params.cfg.cron?.webhookToken?.trim();
        const legacyWebhook = params.cfg.cron?.webhook?.trim();
        const job = cron.getJob(evt.jobId);
        const legacyNotify = (job as { notify?: unknown } | undefined)?.notify === true;
        const webhookTarget = resolveCronWebhookTarget({
          delivery:
            job?.delivery && typeof job.delivery.mode === "string"
              ? { mode: job.delivery.mode, to: job.delivery.to }
              : undefined,
          legacyNotify,
          legacyWebhook,
        });

        if (!webhookTarget && job?.delivery?.mode === "webhook") {
          cronLogger.warn(
            {
              jobId: evt.jobId,
              deliveryTo: job.delivery.to,
            },
            "cron: skipped webhook delivery, delivery.to must be a valid http(s) URL",
          );
        }

        if (webhookTarget?.source === "legacy" && !warnedLegacyWebhookJobs.has(evt.jobId)) {
          warnedLegacyWebhookJobs.add(evt.jobId);
          cronLogger.warn(
            {
              jobId: evt.jobId,
              legacyWebhook: redactWebhookUrl(webhookTarget.url),
            },
            "cron: deprecated notify+cron.webhook fallback in use, migrate to delivery.mode=webhook with delivery.to",
          );
        }

        if (webhookTarget && evt.summary) {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (webhookToken) {
            // Strip CR/LF from the token to prevent HTTP header injection (CRLF injection).
            // undici rejects headers with control characters, but we sanitize explicitly
            // to fail fast and avoid ambiguous behavior if the HTTP layer changes.
            const safeToken = webhookToken.replace(/[\r\n]/g, "");
            if (safeToken) {
              headers.Authorization = `Bearer ${safeToken}`;
            }
          }
          const abortController = new AbortController();
          const timeout = setTimeout(() => {
            abortController.abort();
          }, CRON_WEBHOOK_TIMEOUT_MS);
          void fetchWithSsrFGuard({
            url: webhookTarget.url,
            init: {
              method: "POST",
              headers,
              body: JSON.stringify(evt),
              signal: abortController.signal,
            },
          })
            .then(({ response }) => response)
            .catch((err) => {
              cronLogger.warn(
                {
                  err: String(err),
                  jobId: evt.jobId,
                  webhookUrl: redactWebhookUrl(webhookTarget.url),
                },
                "cron: webhook delivery failed",
              );
            })
            .finally(() => {
              clearTimeout(timeout);
            });
        }
        const logPath = resolveCronRunLogPath({
          storePath,
          jobId: evt.jobId,
        });
        void appendCronRunLog(logPath, {
          ts: Date.now(),
          jobId: evt.jobId,
          action: "finished",
          status: evt.status,
          error: evt.error,
          summary: evt.summary,
          sessionId: evt.sessionId,
          sessionKey: evt.sessionKey,
          runAtMs: evt.runAtMs,
          durationMs: evt.durationMs,
          nextRunAtMs: evt.nextRunAtMs,
          model: evt.model,
          provider: evt.provider,
          usage: evt.usage,
        }).catch((err) => {
          cronLogger.warn({ err: String(err), logPath }, "cron: run log append failed");
        });
      }
    },
  });

  return { cron, storePath, cronEnabled };
}
