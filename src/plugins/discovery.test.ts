import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverMinionPlugins } from "./discovery.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `minion-plugins-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

async function withStateDir<T>(stateDir: string, fn: () => Promise<T>) {
  const prev = process.env.MINION_STATE_DIR;
  const prevBundled = process.env.MINION_BUNDLED_PLUGINS_DIR;
  process.env.MINION_STATE_DIR = stateDir;
  process.env.MINION_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.MINION_STATE_DIR;
    } else {
      process.env.MINION_STATE_DIR = prev;
    }
    if (prevBundled === undefined) {
      delete process.env.MINION_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.MINION_BUNDLED_PLUGINS_DIR = prevBundled;
    }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("discoverMinionPlugins", () => {
  it("discovers global and workspace extensions", async () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");

    const globalExt = path.join(stateDir, "extensions");
    fs.mkdirSync(globalExt, { recursive: true });
    fs.writeFileSync(path.join(globalExt, "alpha.ts"), "export default function () {}", "utf-8");

    const workspaceExt = path.join(workspaceDir, ".minion", "extensions");
    fs.mkdirSync(workspaceExt, { recursive: true });
    fs.writeFileSync(path.join(workspaceExt, "beta.ts"), "export default function () {}", "utf-8");

    const { candidates } = await withStateDir(stateDir, async () => {
      return discoverMinionPlugins({ workspaceDir });
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
  });

  it("loads package extension packs", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    fs.mkdirSync(path.join(globalExt, "src"), { recursive: true });

    fs.writeFileSync(
      path.join(globalExt, "package.json"),
      JSON.stringify({
        name: "pack",
        minion: { extensions: ["./src/one.ts", "./src/two.ts"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(globalExt, "src", "one.ts"),
      "export default function () {}",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(globalExt, "src", "two.ts"),
      "export default function () {}",
      "utf-8",
    );

    const { candidates } = await withStateDir(stateDir, async () => {
      return discoverMinionPlugins({});
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("pack/one");
    expect(ids).toContain("pack/two");
  });

  it("derives unscoped ids for scoped packages", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "voice-call-pack");
    fs.mkdirSync(path.join(globalExt, "src"), { recursive: true });

    fs.writeFileSync(
      path.join(globalExt, "package.json"),
      JSON.stringify({
        name: "@minion/voice-call",
        minion: { extensions: ["./src/index.ts"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(globalExt, "src", "index.ts"),
      "export default function () {}",
      "utf-8",
    );

    const { candidates } = await withStateDir(stateDir, async () => {
      return discoverMinionPlugins({});
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("voice-call");
  });

  it("emits debug diagnostic for bundled extension with missing source", async () => {
    const stateDir = makeTempDir();
    const bundledDir = makeTempDir();
    const staleExt = path.join(bundledDir, "lobster");
    fs.mkdirSync(staleExt, { recursive: true });
    fs.writeFileSync(
      path.join(staleExt, "package.json"),
      JSON.stringify({
        name: "lobster",
        minion: { extensions: ["./index.ts"] },
      }),
      "utf-8",
    );
    // No index.ts — simulates a stale bundled extension

    const { diagnostics } = await withStateDir(stateDir, async () => {
      // Override bundled dir after withStateDir sets it to /nonexistent
      process.env.MINION_BUNDLED_PLUGINS_DIR = bundledDir;
      return discoverMinionPlugins({});
    });
    const missing = diagnostics.find((d) => d.message.includes("lobster"));
    expect(missing).toBeDefined();
    expect(missing!.level).toBe("debug");
  });

  it("emits warn diagnostic for global extension with missing source", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "stale-pack");
    fs.mkdirSync(globalExt, { recursive: true });
    fs.writeFileSync(
      path.join(globalExt, "package.json"),
      JSON.stringify({
        name: "stale-pack",
        minion: { extensions: ["./index.ts"] },
      }),
      "utf-8",
    );
    // No index.ts — simulates a stale global extension

    const { diagnostics } = await withStateDir(stateDir, async () => {
      return discoverMinionPlugins({});
    });
    const missing = diagnostics.find((d) => d.message.includes("stale-pack"));
    expect(missing).toBeDefined();
    expect(missing!.level).toBe("warn");
  });

  it("treats configured directory paths as plugin packages", async () => {
    const stateDir = makeTempDir();
    const packDir = path.join(stateDir, "packs", "demo-plugin-dir");
    fs.mkdirSync(packDir, { recursive: true });

    fs.writeFileSync(
      path.join(packDir, "package.json"),
      JSON.stringify({
        name: "@minion/demo-plugin-dir",
        minion: { extensions: ["./index.js"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(packDir, "index.js"), "module.exports = {}", "utf-8");

    const { candidates } = await withStateDir(stateDir, async () => {
      return discoverMinionPlugins({ extraPaths: [packDir] });
    });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("demo-plugin-dir");
  });
});
