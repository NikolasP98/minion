import type { PluginRuntime } from "minion/plugin-sdk";

let _runtime: PluginRuntime | undefined;

export function setWeixinRuntime(runtime: PluginRuntime): void {
  _runtime = runtime;
}

export function getWeixinRuntime(): PluginRuntime {
  if (!_runtime) {
    throw new Error("Weixin runtime not initialized — plugin not registered yet");
  }
  return _runtime;
}
