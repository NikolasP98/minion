import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-support/channel-plugins.js";
import {
  buildGatewayReloadPlan,
  diffConfigPaths,
  resolveGatewayReloadSettings,
} from "./config-reload.js";

describe("diffConfigPaths", () => {
  it("captures nested config changes", () => {
    const prev = { hooks: { gmail: { account: "a" } } };
    const next = { hooks: { gmail: { account: "b" } } };
    const paths = diffConfigPaths(prev, next);
    expect(paths).toContain("hooks.gmail.account");
  });

  it("captures array changes", () => {
    const prev = { messages: { groupChat: { mentionPatterns: ["a"] } } };
    const next = { messages: { groupChat: { mentionPatterns: ["b"] } } };
    const paths = diffConfigPaths(prev, next);
    expect(paths).toContain("messages.groupChat.mentionPatterns");
  });
});

describe("buildGatewayReloadPlan", () => {
  const emptyRegistry = createTestRegistry([]);
  const telegramPlugin: ChannelPlugin = {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    reload: { configPrefixes: ["channels.telegram"] },
  };
  const whatsappPlugin: ChannelPlugin = {
    id: "whatsapp",
    meta: {
      id: "whatsapp",
      label: "WhatsApp",
      selectionLabel: "WhatsApp",
      docsPath: "/channels/whatsapp",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
    reload: { configPrefixes: ["web"], noopPrefixes: ["channels.whatsapp"] },
  };
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
  ]);

  beforeEach(() => {
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("marks gateway changes as restart required", () => {
    const plan = buildGatewayReloadPlan(["gateway.port"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("gateway.port");
  });

  it("restarts the Gmail watcher for hooks.gmail changes", () => {
    const plan = buildGatewayReloadPlan(["hooks.gmail.account"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartGmailWatcher).toBe(true);
    expect(plan.reloadHooks).toBe(true);
  });

  it("restarts providers when provider config prefixes change", () => {
    const changedPaths = ["web.enabled", "channels.telegram.botToken"];
    const plan = buildGatewayReloadPlan(changedPaths);
    expect(plan.restartGateway).toBe(false);
    const expected = new Set(
      listChannelPlugins()
        .filter((plugin) =>
          (plugin.reload?.configPrefixes ?? []).some((prefix) =>
            changedPaths.some((path) => path === prefix || path.startsWith(`${prefix}.`)),
          ),
        )
        .map((plugin) => plugin.id),
    );
    expect(expected.size).toBeGreaterThan(0);
    expect(plan.restartChannels).toEqual(expected);
  });

  it("auto-registers channels.<id> as hot-reloadable for plugins without explicit reload config", () => {
    const discordPlugin: ChannelPlugin = {
      id: "discord",
      meta: {
        id: "discord",
        label: "Discord",
        selectionLabel: "Discord",
        docsPath: "/channels/discord",
        blurb: "test",
      },
      capabilities: { chatTypes: ["direct"] },
      config: { listAccountIds: () => [], resolveAccount: () => ({}) },
      // No reload config — should auto-register channels.discord
    };
    const autoRegistry = createTestRegistry([
      { pluginId: "discord", plugin: discordPlugin, source: "test" },
    ]);
    setActivePluginRegistry(autoRegistry);

    const plan = buildGatewayReloadPlan(["channels.discord.accounts.farquaad.enabled"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartChannels).toEqual(new Set(["discord"]));
  });

  it("auto-registered channel prefix does not override explicit reload config", () => {
    // whatsappPlugin has channels.whatsapp as noop — auto-registration should not override it
    const plan = buildGatewayReloadPlan(["channels.whatsapp.accounts.default.enabled"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("channels.whatsapp.accounts.default.enabled");
  });

  it("treats gateway.remote as no-op", () => {
    const plan = buildGatewayReloadPlan(["gateway.remote.url"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("gateway.remote.url");
  });

  it("defaults unknown paths to restart", () => {
    const plan = buildGatewayReloadPlan(["unknownField"]);
    expect(plan.restartGateway).toBe(true);
  });

  // === Agent settings: no restart ===

  it("treats agents.list tool deny changes as no-op (no restart)", () => {
    const plan = buildGatewayReloadPlan(["agents.list"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("agents.list");
  });

  it("treats agents.list.0.tools.deny changes as no-op", () => {
    const paths = diffConfigPaths(
      { agents: { list: [{ id: "a", tools: { deny: ["web_search"] } }] } },
      { agents: { list: [{ id: "a", tools: { deny: ["web_search", "browser"] } }] } },
    );
    const plan = buildGatewayReloadPlan(paths);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths.length).toBeGreaterThan(0);
    expect(plan.noopPaths.every((p) => p.startsWith("agents."))).toBe(true);
  });

  it("treats agents.list.0.tools.alsoAllow changes as no-op", () => {
    const paths = diffConfigPaths(
      { agents: { list: [{ id: "a", tools: {} }] } },
      { agents: { list: [{ id: "a", tools: { alsoAllow: ["web_search"] } }] } },
    );
    const plan = buildGatewayReloadPlan(paths);
    expect(plan.restartGateway).toBe(false);
  });

  it("treats agents.list.0.tools.profile changes as no-op", () => {
    const paths = diffConfigPaths(
      { agents: { list: [{ id: "a", tools: { profile: "full" } }] } },
      { agents: { list: [{ id: "a", tools: { profile: "minimal" } }] } },
    );
    const plan = buildGatewayReloadPlan(paths);
    expect(plan.restartGateway).toBe(false);
  });

  it("treats agents.list.0.skills changes as no-op", () => {
    const paths = diffConfigPaths(
      { agents: { list: [{ id: "a", skills: ["skill-a"] }] } },
      { agents: { list: [{ id: "a", skills: ["skill-a", "skill-b"] }] } },
    );
    const plan = buildGatewayReloadPlan(paths);
    expect(plan.restartGateway).toBe(false);
  });

  it("treats agents.list.0.model changes as no-op", () => {
    const paths = diffConfigPaths(
      { agents: { list: [{ id: "a", model: "claude-sonnet" }] } },
      { agents: { list: [{ id: "a", model: "claude-opus" }] } },
    );
    const plan = buildGatewayReloadPlan(paths);
    expect(plan.restartGateway).toBe(false);
  });

  it("treats tools.exec changes as no-op", () => {
    const plan = buildGatewayReloadPlan(["tools.exec.node"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("tools.exec.node");
  });

  it("treats models.* changes as no-op", () => {
    const plan = buildGatewayReloadPlan(["models.primary"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("models.primary");
  });

  it("treats routing.* changes as no-op", () => {
    const plan = buildGatewayReloadPlan(["routing.default"]);
    expect(plan.restartGateway).toBe(false);
  });

  it("treats skills.* changes as no-op", () => {
    const plan = buildGatewayReloadPlan(["skills.apiKeys"]);
    expect(plan.restartGateway).toBe(false);
  });

  // === Settings that DO cause restart ===

  it("restarts for gateway.port changes", () => {
    const plan = buildGatewayReloadPlan(["gateway.port"]);
    expect(plan.restartGateway).toBe(true);
  });

  it("restarts for gateway.auth changes", () => {
    const plan = buildGatewayReloadPlan(["gateway.auth.token"]);
    expect(plan.restartGateway).toBe(true);
  });

  it("restarts for gateway.bind changes", () => {
    const plan = buildGatewayReloadPlan(["gateway.bind"]);
    expect(plan.restartGateway).toBe(true);
  });

  it("restarts for plugins.* changes", () => {
    const plan = buildGatewayReloadPlan(["plugins.mcp"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("plugins.mcp");
  });

  it("restarts for discovery.* changes", () => {
    const plan = buildGatewayReloadPlan(["discovery.port"]);
    expect(plan.restartGateway).toBe(true);
  });

  it("restarts for canvasHost changes", () => {
    const plan = buildGatewayReloadPlan(["canvasHost"]);
    expect(plan.restartGateway).toBe(true);
  });

  // === Hot reload (subsystem restart, no gateway restart) ===

  it("hot reloads hooks for hooks.internal changes", () => {
    const plan = buildGatewayReloadPlan(["hooks.internal.key"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.reloadHooks).toBe(true);
  });

  it("hot reloads cron for cron changes", () => {
    const plan = buildGatewayReloadPlan(["cron.jobs"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartCron).toBe(true);
  });

  it("hot reloads browser for browser changes", () => {
    const plan = buildGatewayReloadPlan(["browser.defaultProfile"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartBrowserControl).toBe(true);
  });

  it("hot reloads heartbeat for agents.defaults.heartbeat changes", () => {
    const plan = buildGatewayReloadPlan(["agents.defaults.heartbeat.intervalMs"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.restartHeartbeat).toBe(true);
  });

  // === Mixed scenarios ===

  it("restarts when mix of no-op and restart paths are changed", () => {
    const plan = buildGatewayReloadPlan(["agents.list", "gateway.port"]);
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons).toContain("gateway.port");
    expect(plan.noopPaths).toContain("agents.list");
  });

  it("does not restart when only no-op and hot paths change", () => {
    const plan = buildGatewayReloadPlan(["agents.list", "hooks.internal.key", "models.primary"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.reloadHooks).toBe(true);
    expect(plan.noopPaths).toContain("agents.list");
    expect(plan.noopPaths).toContain("models.primary");
  });

  it("does not restart for gateway.remote (exempted from gateway restart)", () => {
    const plan = buildGatewayReloadPlan(["gateway.remote.url"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("gateway.remote.url");
  });

  it("does not restart for gateway.reload (exempted from gateway restart)", () => {
    const plan = buildGatewayReloadPlan(["gateway.reload.mode"]);
    expect(plan.restartGateway).toBe(false);
    expect(plan.noopPaths).toContain("gateway.reload.mode");
  });
});

// === End-to-end: diffConfigPaths + buildGatewayReloadPlan ===

describe("settings change scenarios (diff → plan)", () => {
  const emptyRegistry = createTestRegistry([]);

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("tool toggle via tools.overrides.set only touches agents.*", () => {
    const prev = {
      agents: { list: [{ id: "main", tools: { deny: [] } }] },
      gateway: { port: 8080 },
    };
    const next = {
      agents: { list: [{ id: "main", tools: { deny: ["web_search"] } }] },
      gateway: { port: 8080 },
    };
    const paths = diffConfigPaths(prev, next);
    expect(paths.every((p) => p.startsWith("agents."))).toBe(true);
    const plan = buildGatewayReloadPlan(paths);
    expect(plan.restartGateway).toBe(false);
  });

  it("skill toggle via agents.skills.set only touches agents.*", () => {
    const prev = {
      agents: { list: [{ id: "main" }] },
      gateway: { port: 8080 },
    };
    const next = {
      agents: { list: [{ id: "main", skills: ["skill-a"] }] },
      gateway: { port: 8080 },
    };
    const paths = diffConfigPaths(prev, next);
    expect(paths.every((p) => p.startsWith("agents."))).toBe(true);
    const plan = buildGatewayReloadPlan(paths);
    expect(plan.restartGateway).toBe(false);
  });

  it("profile change via tools.overrides.set only touches agents.*", () => {
    const prev = {
      agents: { list: [{ id: "main", tools: { profile: "full" } }] },
      plugins: { mcp: {} },
    };
    const next = {
      agents: { list: [{ id: "main", tools: { profile: "minimal" } }] },
      plugins: { mcp: {} },
    };
    const paths = diffConfigPaths(prev, next);
    expect(paths.every((p) => p.startsWith("agents."))).toBe(true);
    const plan = buildGatewayReloadPlan(paths);
    expect(plan.restartGateway).toBe(false);
  });

  it("config.set with form serialization artifacts causes restart", () => {
    // Simulates the old bug: form serialization leaks spurious diffs into
    // restart-triggering paths even though only agent settings changed.
    const prev = {
      agents: { list: [{ id: "main", tools: { deny: [] } }] },
      gateway: { port: 8080, auth: { token: "abc" } },
      plugins: { mcp: { servers: {} } },
    };
    const next = {
      agents: { list: [{ id: "main", tools: { deny: ["web_search"] } }] },
      gateway: { port: "8080", auth: { token: "abc" } }, // string coercion artifact
      plugins: { mcp: { servers: {}, extra: null } }, // null artifact
    };
    const paths = diffConfigPaths(prev, next);
    const plan = buildGatewayReloadPlan(paths);
    // This DOES cause restart because gateway.port changed type
    expect(plan.restartGateway).toBe(true);
    expect(plan.restartReasons.some((r) => r.startsWith("gateway."))).toBe(true);
  });
});

describe("resolveGatewayReloadSettings", () => {
  it("uses defaults when unset", () => {
    const settings = resolveGatewayReloadSettings({});
    expect(settings.mode).toBe("hybrid");
    expect(settings.debounceMs).toBe(300);
  });
});
