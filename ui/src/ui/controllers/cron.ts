import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { CronJob, CronRunLogEntry, CronStatus } from "../types.ts";
import type { CronFormState } from "../ui-types.ts";

export type CronState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronLoading: boolean;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  cronError: string | null;
  cronForm: CronFormState;
  cronRunsJobId: string | null;
  cronRuns: CronRunLogEntry[];
  cronBusy: boolean;
};

export function supportsAnnounceDelivery(
  form: Pick<CronFormState, "sessionTarget" | "payloadKind">,
) {
  return form.sessionTarget === "isolated" && form.payloadKind === "agentTurn";
}

export function normalizeCronFormState(form: CronFormState): CronFormState {
  if (form.deliveryMode !== "announce") {
    return form;
  }
  if (supportsAnnounceDelivery(form)) {
    return form;
  }
  return {
    ...form,
    deliveryMode: "none",
  };
}

export async function loadCronStatus(state: CronState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<CronStatus>("cron.status", {});
    state.cronStatus = res;
  } catch (err) {
    state.cronError = String(err);
  }
}

export async function loadCronJobs(state: CronState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.cronLoading) {
    return;
  }
  state.cronLoading = true;
  state.cronError = null;
  try {
    const res = await state.client.request<{ jobs?: Array<CronJob> }>("cron.list", {
      includeDisabled: true,
    });
    state.cronJobs = Array.isArray(res.jobs) ? res.jobs : [];
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronLoading = false;
  }
}

export function buildCronSchedule(form: CronFormState) {
  if (form.scheduleKind === "at") {
    const ms = Date.parse(form.scheduleAt);
    if (!Number.isFinite(ms)) {
      throw new Error("Invalid run time.");
    }
    return { kind: "at" as const, at: new Date(ms).toISOString() };
  }
  if (form.scheduleKind === "every") {
    const amount = toNumber(form.everyAmount, 0);
    if (amount <= 0) {
      throw new Error("Invalid interval amount.");
    }
    const unit = form.everyUnit;
    const mult = unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
    return { kind: "every" as const, everyMs: amount * mult };
  }
  const expr = form.cronExpr.trim();
  if (!expr) {
    throw new Error("Cron expression required.");
  }
  return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined };
}

export function buildCronPayload(form: CronFormState) {
  if (form.payloadKind === "systemEvent") {
    const text = form.payloadText.trim();
    if (!text) {
      throw new Error("System event text required.");
    }
    return { kind: "systemEvent" as const, text };
  }
  const message = form.payloadText.trim();
  if (!message) {
    throw new Error("Agent message required.");
  }
  const payload: {
    kind: "agentTurn";
    message: string;
    timeoutSeconds?: number;
  } = { kind: "agentTurn", message };
  const timeoutSeconds = toNumber(form.timeoutSeconds, 0);
  if (timeoutSeconds > 0) {
    payload.timeoutSeconds = timeoutSeconds;
  }
  return payload;
}

export async function addCronJob(state: CronState) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    const form = normalizeCronFormState(state.cronForm);
    if (form !== state.cronForm) {
      state.cronForm = form;
    }

    const schedule = buildCronSchedule(form);
    const payload = buildCronPayload(form);
    const selectedDeliveryMode = form.deliveryMode;
    const delivery =
      selectedDeliveryMode && selectedDeliveryMode !== "none"
        ? {
            mode: selectedDeliveryMode,
            channel:
              selectedDeliveryMode === "announce"
                ? form.deliveryChannel.trim() || "last"
                : undefined,
            to: form.deliveryTo.trim() || undefined,
          }
        : undefined;
    const agentId = form.agentId.trim();
    const job = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      agentId: agentId || undefined,
      enabled: form.enabled,
      schedule,
      sessionTarget: form.sessionTarget,
      wakeMode: form.wakeMode,
      payload,
      delivery,
    };
    if (!job.name) {
      throw new Error("Name required.");
    }
    await state.client.request("cron.add", job);
    state.cronForm = {
      ...state.cronForm,
      name: "",
      description: "",
      payloadText: "",
    };
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function toggleCronJob(state: CronState, job: CronJob, enabled: boolean) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.update", { id: job.id, patch: { enabled } });
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function runCronJob(state: CronState, job: CronJob) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.run", { id: job.id, mode: "force" });
    await loadCronRuns(state, job.id);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

// ── Always-On helpers ─────────────────────────────────────────────────────────

/** Prefix used to identify always-on heartbeat cron jobs. */
export const ALWAYS_ON_JOB_NAME_PREFIX = "always-on:";

/** Default heartbeat message sent to the agent on each always-on wake. */
const ALWAYS_ON_HEARTBEAT_MSG =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. " +
  "Do not infer or repeat old tasks from prior chats. " +
  "If nothing needs attention, reply HEARTBEAT_OK.";

/** Preset schedule options for the Always-On picker. */
export type AlwaysOnPreset = "5m" | "15m" | "30m" | "1h" | "6h" | "nightly" | "custom";

export type AlwaysOnScheduleState = {
  preset: AlwaysOnPreset;
  customCronExpr: string;
  customCronTz: string;
};

export function defaultAlwaysOnSchedule(): AlwaysOnScheduleState {
  return { preset: "30m", customCronExpr: "", customCronTz: "" };
}

/** Build the Qdrant schedule from the UI state. */
export function buildAlwaysOnSchedule(s: AlwaysOnScheduleState): import("../types.js").CronSchedule {
  switch (s.preset) {
    case "5m":
      return { kind: "every", everyMs: 5 * 60_000 };
    case "15m":
      return { kind: "every", everyMs: 15 * 60_000 };
    case "30m":
      return { kind: "every", everyMs: 30 * 60_000 };
    case "1h":
      return { kind: "every", everyMs: 60 * 60_000 };
    case "6h":
      return { kind: "every", everyMs: 6 * 60 * 60_000 };
    case "nightly":
      return { kind: "cron", expr: "0 2 * * *" };
    case "custom": {
      const expr = s.customCronExpr.trim();
      if (!expr) {
        throw new Error("Custom cron expression is required.");
      }
      return { kind: "cron", expr, tz: s.customCronTz.trim() || undefined };
    }
  }
}

/** Find the existing always-on cron job for an agent, if any. */
export function findAlwaysOnJob(jobs: CronJob[], agentId: string): CronJob | null {
  return (
    jobs.find(
      (j) => j.name.startsWith(ALWAYS_ON_JOB_NAME_PREFIX) && j.agentId === agentId,
    ) ?? null
  );
}

/**
 * Create or update the always-on heartbeat cron job for an agent.
 * Removes the existing job and re-creates when schedule changes.
 */
export async function saveAlwaysOnJob(
  state: CronState,
  agentId: string,
  schedule: AlwaysOnScheduleState,
  enabled: boolean,
) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    const existing = findAlwaysOnJob(state.cronJobs, agentId);
    if (!enabled) {
      if (existing) {
        await state.client.request("cron.remove", { id: existing.id });
      }
    } else {
      const cronSchedule = buildAlwaysOnSchedule(schedule);
      if (existing) {
        await state.client.request("cron.update", {
          id: existing.id,
          patch: { enabled: true, schedule: cronSchedule },
        });
      } else {
        await state.client.request("cron.add", {
          name: `${ALWAYS_ON_JOB_NAME_PREFIX}${agentId}`,
          description: "Always-On heartbeat schedule",
          agentId,
          enabled: true,
          schedule: cronSchedule,
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: ALWAYS_ON_HEARTBEAT_MSG },
        });
      }
    }
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function removeCronJob(state: CronState, job: CronJob) {
  if (!state.client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await state.client.request("cron.remove", { id: job.id });
    if (state.cronRunsJobId === job.id) {
      state.cronRunsJobId = null;
      state.cronRuns = [];
    }
    await loadCronJobs(state);
    await loadCronStatus(state);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

export async function loadCronRuns(state: CronState, jobId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<{ entries?: Array<CronRunLogEntry> }>("cron.runs", {
      id: jobId,
      limit: 50,
    });
    state.cronRunsJobId = jobId;
    state.cronRuns = Array.isArray(res.entries) ? res.entries : [];
  } catch (err) {
    state.cronError = String(err);
  }
}
