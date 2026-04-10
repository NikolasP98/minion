import type { ToolMeta } from "../tool-meta.js";

export const meta: ToolMeta = {
  id: "parse_screen",
  factory: "createParseScreenTool",
  groups: ["group:ui", "group:minion"],
  contextKeys: ["config"],
  condition: "omniparserEnabled",
};
