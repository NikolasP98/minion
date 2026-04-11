import type { GatewayBrowserClient } from "../gateway.ts";
import type { HookEvent, HookEventsResult } from "../types.ts";
import type { HooksWizardStep } from "../ui-types.ts";

export type HooksState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  hooksLoading: boolean;
  hooksEvents: HookEvent[];
  hooksError: string | null;
  hooksTestBusy: boolean;
  hooksTestResult: string | null;
  hooksTestError: string | null;
  hooksWizardStep: HooksWizardStep;
};

export async function loadHookEvents(state: HooksState) {
  if (!state.client || !state.connected) return;
  if (state.hooksLoading) return;
  state.hooksLoading = true;
  state.hooksError = null;
  try {
    const res = await state.client.request<HookEventsResult>("hooks.events", {});
    state.hooksEvents = Array.isArray(res.events) ? res.events : [];
  } catch (err) {
    state.hooksError = String(err);
  } finally {
    state.hooksLoading = false;
  }
}

export async function testHook(state: HooksState) {
  if (!state.client || !state.connected) return;
  if (state.hooksTestBusy) return;
  state.hooksTestBusy = true;
  state.hooksTestResult = null;
  state.hooksTestError = null;
  try {
    const res = await state.client.request<{ ok: boolean; message?: string }>("hooks.test", {});
    state.hooksTestResult = res.message ?? (res.ok ? "Test event dispatched." : "Test returned ok=false.");
  } catch (err) {
    state.hooksTestError = String(err);
  } finally {
    state.hooksTestBusy = false;
  }
}
