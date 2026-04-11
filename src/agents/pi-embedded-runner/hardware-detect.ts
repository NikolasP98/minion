/**
 * Hardware detection utilities for local model capability checks.
 *
 * Used to gate privacy mode and on-device inference behind a RAM check
 * (≥16 GB required for Phi-4 14B and similar local models).
 *
 * Feature flags:
 *   MINION_PRIVACY_MODE=true|1    — force all inference to local providers
 *   MINION_LOCAL_MODEL=phi-4      — local model to use in privacy mode (default: phi-4)
 */

import { totalmem } from "node:os";

import { log } from "./logger.js";

/** Minimum RAM in GB required to run a local 14B model (Phi-4, Llama-3 8B, etc.). */
export const MIN_LOCAL_RAM_GB = 16;

/** Default local provider name when privacy mode is active. */
export const PRIVACY_MODE_PROVIDER = "ollama";

/** Default local model when privacy mode is active. */
export const PRIVACY_MODE_DEFAULT_MODEL = "phi-4";

/**
 * Returns total system RAM in gigabytes (using OS physical memory).
 * Always returns a positive number; falls back to 0 on errors.
 */
export function checkRamGb(): number {
  try {
    const bytes = totalmem();
    return bytes / 1_073_741_824; // 1024^3
  } catch {
    return 0;
  }
}

/**
 * Returns true if the host has enough RAM to run a local 14B model (≥16 GB).
 */
export function isLocalModelCapable(): boolean {
  return checkRamGb() >= MIN_LOCAL_RAM_GB;
}

/**
 * Returns true when MINION_PRIVACY_MODE is set to "true" or "1".
 */
export function isPrivacyModeEnabled(): boolean {
  const v = process.env.MINION_PRIVACY_MODE?.trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Returns the local model override when privacy mode is active, or null when it is not.
 *
 * - If privacy mode is off: returns null (no override).
 * - If privacy mode is on and the current provider is already local: returns null (no override needed).
 * - If privacy mode is on and hardware is insufficient: logs a warning and returns null.
 * - If privacy mode is on and hardware is sufficient: returns `{ provider, modelId }` for the local provider.
 *
 * The target model can be customised via the `MINION_LOCAL_MODEL` env var.
 */
export function resolvePrivacyModeOverride(
  currentProvider: string,
  currentModelId: string,
): { provider: string; modelId: string } | null {
  if (!isPrivacyModeEnabled()) {
    return null;
  }

  // Already routed to a local provider — no override needed.
  const local = currentProvider === PRIVACY_MODE_PROVIDER || currentProvider === "lmstudio" || currentProvider === "vllm";
  if (local) {
    return null;
  }

  if (!isLocalModelCapable()) {
    const ramGb = checkRamGb().toFixed(1);
    log.warn(
      `[privacy-mode] MINION_PRIVACY_MODE is set but hardware check failed: ` +
        `${ramGb} GB RAM detected, ${MIN_LOCAL_RAM_GB} GB required. ` +
        `Continuing with requested provider "${currentProvider}" / model "${currentModelId}".`,
    );
    return null;
  }

  const localModel = (process.env.MINION_LOCAL_MODEL?.trim()) || PRIVACY_MODE_DEFAULT_MODEL;
  log.info(
    `[privacy-mode] routing to local provider ${PRIVACY_MODE_PROVIDER}/${localModel} ` +
      `(was ${currentProvider}/${currentModelId})`,
  );
  return { provider: PRIVACY_MODE_PROVIDER, modelId: localModel };
}
