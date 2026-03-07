import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("memory");

let maxConcurrency = 2;
let active = 0;
const waitQueue: Array<() => void> = [];

export function setEmbedConcurrency(limit: number): void {
  maxConcurrency = Math.max(1, Math.floor(limit));
  log.info(`qmd embed concurrency set to ${maxConcurrency}`);
}

export function getEmbedConcurrency(): number {
  return maxConcurrency;
}

export async function acquireEmbedSlot(agentId: string): Promise<() => void> {
  if (active < maxConcurrency) {
    active++;
    log.debug(`qmd embed slot acquired for "${agentId}" (${active}/${maxConcurrency} active)`);
    return () => releaseSlot(agentId);
  }
  log.info(
    `qmd embed slot full (${active}/${maxConcurrency}), "${agentId}" queued (${waitQueue.length + 1} waiting)`,
  );
  return new Promise<() => void>((resolve) => {
    waitQueue.push(() => {
      active++;
      log.debug(
        `qmd embed slot acquired for "${agentId}" after wait (${active}/${maxConcurrency} active, ${waitQueue.length} still waiting)`,
      );
      resolve(() => releaseSlot(agentId));
    });
  });
}

function releaseSlot(agentId: string): void {
  active--;
  log.debug(`qmd embed slot released by "${agentId}" (${active}/${maxConcurrency} active)`);
  const next = waitQueue.shift();
  if (next) {
    next();
  }
}
