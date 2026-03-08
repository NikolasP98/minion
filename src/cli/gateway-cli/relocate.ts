import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { resolveStateDir } from "../../config/paths.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";

// ============================================================================
// File discovery — glob patterns for files that contain absolute paths
// ============================================================================

const STATE_FILE_GLOBS = [
  // Top-level config and state
  "gateway.json",
  "agents-list.json",
  "exec-approvals.json",
  // Per-agent session registries
  "agents/*/sessions/sessions.json",
  // Per-agent qmd collection configs
  "agents/*/qmd/xdg-config/qmd/index.yml",
  // Per-agent auth credential files
  "agents/*/auth-credentials/google/*.json",
  "agents/*/auth-credentials/**/*.json",
];

function matchGlob(relativePath: string, pattern: string): boolean {
  const placeholder = "<<GLOBSTAR>>";
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, placeholder)
    .replace(/\*/g, "[^/]*")
    .replaceAll(placeholder, ".*");
  return new RegExp(`^${regexStr}$`).test(relativePath);
}

function discoverFiles(stateDir: string): string[] {
  const found: string[] = [];

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip directories we never need to scan
        if (
          entry.name === "workspaces" ||
          entry.name === "logs" ||
          entry.name === "browser" ||
          entry.name === "canvas" ||
          entry.name === "completions" ||
          entry.name === "KG" ||
          entry.name === "delivery-queue" ||
          entry.name === "memory" ||
          entry.name === "xdg-cache"
        ) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(stateDir, fullPath);
        for (const pattern of STATE_FILE_GLOBS) {
          if (matchGlob(relativePath, pattern)) {
            found.push(fullPath);
            break;
          }
        }
      }
    }
  }

  walk(stateDir);
  return found.toSorted();
}

// ============================================================================
// Path rewriting — JSON-aware recursive string replacement
// ============================================================================

type Replacement = { from: string; to: string };

function applyReplacements(value: string, replacements: Replacement[]): string {
  let result = value;
  for (const { from, to } of replacements) {
    // Use split+join for literal replacement (no regex escaping needed)
    result = result.split(from).join(to);
  }
  return result;
}

function rewriteJsonValue(value: unknown, replacements: Replacement[]): unknown {
  if (typeof value === "string") {
    return applyReplacements(value, replacements);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteJsonValue(item, replacements));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = rewriteJsonValue(val, replacements);
    }
    return result;
  }
  return value;
}

type RewriteResult = {
  filePath: string;
  changed: boolean;
  matchCount: number;
};

function rewriteJsonFile(
  filePath: string,
  replacements: Replacement[],
  dryRun: boolean,
): RewriteResult {
  const content = fs.readFileSync(filePath, "utf-8");

  // Count how many replacements would apply
  let matchCount = 0;
  for (const { from } of replacements) {
    const parts = content.split(from);
    matchCount += parts.length - 1;
  }

  if (matchCount === 0) {
    return { filePath, changed: false, matchCount: 0 };
  }

  if (!dryRun) {
    const parsed = JSON.parse(content);
    const rewritten = rewriteJsonValue(parsed, replacements);
    // Detect indentation from original file
    const indent = content.match(/^\s+"/m)?.[0]?.match(/^\s+/)?.[0]?.length ?? 2;
    fs.writeFileSync(filePath, JSON.stringify(rewritten, null, indent) + "\n");
  }

  return { filePath, changed: true, matchCount };
}

function rewriteYamlFile(
  filePath: string,
  replacements: Replacement[],
  dryRun: boolean,
): RewriteResult {
  const content = fs.readFileSync(filePath, "utf-8");

  let matchCount = 0;
  for (const { from } of replacements) {
    const parts = content.split(from);
    matchCount += parts.length - 1;
  }

  if (matchCount === 0) {
    return { filePath, changed: false, matchCount: 0 };
  }

  if (!dryRun) {
    const rewritten = applyReplacements(content, replacements);
    fs.writeFileSync(filePath, rewritten);
  }

  return { filePath, changed: true, matchCount };
}

function rewriteFile(
  filePath: string,
  replacements: Replacement[],
  dryRun: boolean,
): RewriteResult {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".yml" || ext === ".yaml") {
    return rewriteYamlFile(filePath, replacements, dryRun);
  }
  return rewriteJsonFile(filePath, replacements, dryRun);
}

// ============================================================================
// CLI command
// ============================================================================

interface RelocateOpts {
  from: string;
  to: string;
  fromHost?: string;
  toHost?: string;
  stateDir?: string;
  dryRun?: boolean;
}

export function addGatewayRelocateCommand(parent: Command): void {
  parent
    .command("relocate")
    .description("Rewrite absolute paths in state files after server migration")
    .requiredOption("--from <path>", "Old path prefix to replace (e.g. /home/minion)")
    .requiredOption("--to <path>", "New path prefix (e.g. /home/bot-prd)")
    .option("--from-host <hostname>", "Old hostname to replace (e.g. protopi.example.ts.net)")
    .option("--to-host <hostname>", "New hostname (e.g. newserver.example.ts.net)")
    .option("--state-dir <dir>", "State directory (default: ~/.minion)")
    .option("--dry-run", "Show what would be changed without modifying files", false)
    .action(async (opts: RelocateOpts) => {
      const rich = isRich();
      const stateDir = opts.stateDir ? path.resolve(opts.stateDir) : resolveStateDir();

      if (!fs.existsSync(stateDir)) {
        defaultRuntime.error(`State directory not found: ${stateDir}`);
        defaultRuntime.exit(1);
        return;
      }

      // Build replacement list
      const replacements: Replacement[] = [];

      // Path prefix replacement — ensure trailing slash consistency
      const fromPath = opts.from.endsWith("/") ? opts.from : opts.from + "/";
      const toPath = opts.to.endsWith("/") ? opts.to : opts.to + "/";
      replacements.push({ from: fromPath, to: toPath });
      // Also replace without trailing slash for cases like bare directory references
      replacements.push({ from: opts.from.replace(/\/$/, ""), to: opts.to.replace(/\/$/, "") });

      // Hostname replacement
      if (opts.fromHost && opts.toHost) {
        replacements.push({ from: opts.fromHost, to: opts.toHost });
      }

      if (opts.dryRun) {
        defaultRuntime.log(colorize(rich, theme.heading, "Relocate (dry run)"));
      } else {
        defaultRuntime.log(colorize(rich, theme.heading, "Relocate"));
      }

      defaultRuntime.log(colorize(rich, theme.muted, `State dir: ${stateDir}`));
      for (const r of replacements) {
        defaultRuntime.log(
          `  ${colorize(rich, theme.error, r.from)} → ${colorize(rich, theme.success, r.to)}`,
        );
      }

      // Discover and rewrite files
      const files = discoverFiles(stateDir);
      defaultRuntime.log(colorize(rich, theme.muted, `\nScanning ${files.length} state files...`));

      let totalChanged = 0;
      let totalMatches = 0;

      for (const filePath of files) {
        try {
          const result = rewriteFile(filePath, replacements, opts.dryRun ?? false);
          if (result.changed) {
            totalChanged++;
            totalMatches += result.matchCount;
            const relPath = path.relative(stateDir, filePath);
            const action = opts.dryRun ? "would rewrite" : "rewritten";
            defaultRuntime.log(
              `  ${colorize(rich, theme.success, "✓")} ${relPath} (${result.matchCount} ${result.matchCount === 1 ? "replacement" : "replacements"} ${action})`,
            );
          }
        } catch (err) {
          const relPath = path.relative(stateDir, filePath);
          defaultRuntime.error(
            `  ${colorize(rich, theme.error, "✗")} ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      defaultRuntime.log(
        `\n${totalChanged} file(s) ${opts.dryRun ? "would be" : ""} modified, ${totalMatches} total replacements`,
      );

      if (!opts.dryRun && totalChanged > 0) {
        // Validate gateway.json is still valid JSON
        const gatewayJsonPath = path.join(stateDir, "gateway.json");
        if (fs.existsSync(gatewayJsonPath)) {
          try {
            JSON.parse(fs.readFileSync(gatewayJsonPath, "utf-8"));
            defaultRuntime.log(
              colorize(rich, theme.success, "gateway.json validated as valid JSON"),
            );
          } catch (err) {
            defaultRuntime.error(
              colorize(
                rich,
                theme.error,
                `WARNING: gateway.json is invalid JSON after rewrite: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
        }
      }
    });
}
