import type { MinionPluginApi } from "minion/plugin-sdk";
import { emptyPluginConfigSchema } from "minion/plugin-sdk";
import { weixinPlugin } from "./src/channel.js";
import { setWeixinRuntime } from "./src/runtime.js";

export { monitorWeixinProvider } from "./src/monitor.js";
export { sendMessageWeixin } from "./src/send.js";
export { probeWeixin } from "./src/probe.js";
export { normalizeWeixinMessage, resolveOutboundTarget } from "./src/normalize.js";
export { normalizeWeixinTarget, looksLikeWeixinId, formatWeixinTarget } from "./src/targets.js";
export { weixinPlugin } from "./src/channel.js";

const plugin = {
  id: "weixin",
  name: "Weixin",
  description: "Weixin/WeChat channel plugin via iLink Bot API",
  configSchema: emptyPluginConfigSchema(),
  register(api: MinionPluginApi) {
    setWeixinRuntime(api.runtime);
    api.registerChannel({ plugin: weixinPlugin });
  },
};

export default plugin;
