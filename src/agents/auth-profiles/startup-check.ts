import { emitReliabilityEvent } from "../../logging/reliability.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildAuthHealthSummary, type AuthHealthSummary } from "../auth-health.js";
import { enforceAllAuthProfilePermissions } from "./permissions.js";
import { ensureAuthProfileStore } from "./store.js";

const log = createSubsystemLogger("auth/startup");

/**
 * Run at gateway startup to validate credential health and emit reliability events
 * for any missing or expired credentials.
 */
export function runStartupCredentialCheck(params?: {
  cfg?: Parameters<typeof buildAuthHealthSummary>[0]["cfg"];
}): AuthHealthSummary | null {
  // Enforce secure permissions on all auth profile files on every startup.
  // New writes already use 0700/0600, but existing files from older versions
  // may have looser permissions. This is a best-effort, non-blocking pass.
  try {
    enforceAllAuthProfilePermissions();
  } catch (err) {
    log.warn("auth profile permission enforcement failed", { err: String(err) });
  }

  try {
    const store = ensureAuthProfileStore();
    const summary = buildAuthHealthSummary({ store, cfg: params?.cfg });

    const profileCount = summary.profiles.length;
    const expired = summary.profiles.filter((p) => p.status === "expired");
    const missing = summary.profiles.filter((p) => p.status === "missing");
    const expiring = summary.profiles.filter((p) => p.status === "expiring");
    const ok = summary.profiles.filter((p) => p.status === "ok" || p.status === "static");

    log.info("credential health check", {
      total: profileCount,
      ok: ok.length,
      expiring: expiring.length,
      expired: expired.length,
      missing: missing.length,
    });

    // Emit per-provider summary for quick scanning
    for (const provider of summary.providers) {
      log.info(`  ${provider.provider}: ${provider.status}`, {
        profiles: provider.profiles.length,
        ...(provider.remainingMs !== undefined ? { remainingMs: provider.remainingMs } : {}),
      });
    }

    // Emit reliability events for problematic credentials
    for (const profile of expired) {
      emitReliabilityEvent({
        category: "auth",
        severity: "high",
        event: "credential.expired",
        message: `${profile.provider} credential "${profile.profileId}" is expired`,
        metadata: {
          profileId: profile.profileId,
          provider: profile.provider,
          type: profile.type,
        },
      });
    }

    for (const profile of missing) {
      emitReliabilityEvent({
        category: "auth",
        severity: "high",
        event: "credential.missing",
        message: `${profile.provider} credential "${profile.profileId}" has missing token data`,
        metadata: {
          profileId: profile.profileId,
          provider: profile.provider,
          type: profile.type,
        },
      });
    }

    for (const profile of expiring) {
      emitReliabilityEvent({
        category: "auth",
        severity: "medium",
        event: "credential.expiring",
        message: `${profile.provider} credential "${profile.profileId}" is expiring soon`,
        metadata: {
          profileId: profile.profileId,
          provider: profile.provider,
          type: profile.type,
          remainingMs: profile.remainingMs,
        },
      });
    }

    return summary;
  } catch (err) {
    log.error("startup credential check failed", { err: String(err) });
    emitReliabilityEvent({
      category: "auth",
      severity: "critical",
      event: "credential.check_failed",
      message: `Startup credential check failed: ${String(err)}`,
    });
    return null;
  }
}
