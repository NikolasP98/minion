#!/usr/bin/env bun
/**
 * Safe gateway.json editor — avoids jq-induced config drift.
 *
 * Usage:
 *   bun run scripts/edit-gateway-config.ts --set 'channels.discord.accounts.newbot.token=xxx'
 *   bun run scripts/edit-gateway-config.ts --set 'channels.discord.startupStaggerMs=2000'
 *   bun run scripts/edit-gateway-config.ts --json '{"channels":{"discord":{"enabled":true}}}'
 */

import fs from "node:fs";
import path from "node:path";

const CONFIG_DIR = process.env.MINION_CONFIG_DIR ?? path.join(process.env.HOME ?? "", ".minion");
const CONFIG_PATH = path.join(CONFIG_DIR, "gateway.json");

function deepSet(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof target[key] === "object" &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

function parseValue(raw: string): unknown {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw === "null") {
    return null;
  }
  const num = Number(raw);
  if (!Number.isNaN(num) && raw.trim() !== "") {
    return num;
  }
  return raw;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: edit-gateway-config.ts --set 'key.path=value' | --json '{...}'");
    process.exit(1);
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const cfg = JSON.parse(raw) as Record<string, unknown>;

  // Backup
  const backupPath = `${CONFIG_PATH}.bak`;
  fs.copyFileSync(CONFIG_PATH, backupPath);

  let modified = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--set" && args[i + 1]) {
      const expr = args[++i];
      const eqIdx = expr.indexOf("=");
      if (eqIdx < 1) {
        console.error(`Invalid --set expression: ${expr}`);
        process.exit(1);
      }
      const keyPath = expr.slice(0, eqIdx);
      const value = parseValue(expr.slice(eqIdx + 1));
      deepSet(cfg, keyPath, value);
      console.log(`  set ${keyPath} = ${JSON.stringify(value)}`);
      modified = true;
    } else if (args[i] === "--json" && args[i + 1]) {
      const patch = JSON.parse(args[++i]) as Record<string, unknown>;
      deepMerge(cfg, patch);
      console.log(`  merged JSON patch`);
      modified = true;
    }
  }

  if (!modified) {
    console.error("No changes specified.");
    process.exit(1);
  }

  // Atomic write
  const tmpPath = `${CONFIG_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, CONFIG_PATH);
  console.log(`✓ Updated ${CONFIG_PATH} (backup: ${backupPath})`);
}

main();
