const HOOK_EVENT_LOG_MAX = 100;

export type HookEventStatus = "dispatched" | "skipped" | "rejected" | "error";

export type HookEventEntry = {
  id: string;
  timestamp: string;
  path: string;
  eventType?: string;
  agentId?: string;
  runId?: string;
  status: HookEventStatus;
  detail?: string;
};

const hookEventLog: HookEventEntry[] = [];
let hookEventCounter = 0;

export function logHookEvent(entry: Omit<HookEventEntry, "id">): void {
  hookEventCounter++;
  const record: HookEventEntry = {
    id: String(hookEventCounter),
    ...entry,
  };
  hookEventLog.push(record);
  if (hookEventLog.length > HOOK_EVENT_LOG_MAX) {
    hookEventLog.shift();
  }
}

export function getHookEvents(): HookEventEntry[] {
  return hookEventLog.slice().reverse();
}
