import { listAgentIds } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { setEmbedConcurrency } from "../../memory/compaction/qmd-embed-semaphore.js";
import { getMemorySearchManager } from "../../memory/index.js";

const BOOT_STAGGER_MS = 2_000;

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  let concurrencySet = false;
  let qmdAgentCount = 0;

  for (const agentId of agentIds) {
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    if (resolved.backend !== "qmd" || !resolved.qmd) {
      continue;
    }

    if (!concurrencySet) {
      setEmbedConcurrency(resolved.qmd.update.embedConcurrency);
      concurrencySet = true;
    }

    // Stagger boot updates to avoid thundering herd
    if (qmdAgentCount > 0) {
      await new Promise((r) => setTimeout(r, BOOT_STAGGER_MS));
    }
    qmdAgentCount++;

    const { manager, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
    if (!manager) {
      params.log.warn(
        `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    params.log.info?.(`qmd memory startup initialization armed for agent "${agentId}"`);
  }

  params.log.info?.(
    `qmd memory startup complete: ${qmdAgentCount} agents initialized with embed concurrency ${concurrencySet ? "configured" : "default"}`,
  );
}
