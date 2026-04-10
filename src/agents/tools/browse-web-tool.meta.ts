import type { ToolMeta } from "../tool-meta.js";

export const meta: ToolMeta = {
  id: "browse_web",
  factory: "createBrowseWebTool",
  groups: ["group:web", "group:minion"],
  contextKeys: ["config"],
  condition: "browseuseEnabled",
};
