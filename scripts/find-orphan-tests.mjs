#!/usr/bin/env node

/**
 * Detects orphan test files:
 * 1. Test files with unresolvable relative imports
 * 2. Test files not matched by any vitest config include pattern
 *
 * Usage: node scripts/find-orphan-tests.mjs
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// Vitest config include patterns (extracted from vitest*.config.ts files)
const VITEST_INCLUDES = [
  "src/**/*.test.ts",
  "extensions/**/*.test.ts",
  "test/**/*.test.ts",
  "test/**/*.e2e.test.ts",
  "src/**/*.e2e.test.ts",
  "src/gateway/**/*.test.ts",
  "src/**/*.live.test.ts",
];

const IGNORE_DIRS = new Set(["node_modules", "dist", ".worktrees", "apps", ".git"]);

function walkDir(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) {
        continue;
      }
      walkDir(path.join(dir, entry.name), results);
    } else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      results.push(path.relative(ROOT, path.join(dir, entry.name)));
    }
  }
  return results;
}

function extractImports(content) {
  const imports = [];
  const re = /(?:import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'])/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const specifier = match[1];
    if (specifier?.startsWith(".")) {
      imports.push(specifier);
    }
  }
  return imports;
}

function resolveImport(fromFile, specifier) {
  const dir = path.dirname(path.join(ROOT, fromFile));
  const base = specifier.replace(/\.js$/, "");
  const resolved = path.resolve(dir, base);

  const candidates = [
    `${resolved}.ts`,
    `${resolved}.tsx`,
    `${resolved}.js`,
    `${resolved}.mjs`,
    path.join(resolved, "index.ts"),
    path.join(resolved, "index.tsx"),
    path.join(resolved, "index.js"),
    resolved,
  ];

  return candidates.some((c) => fs.existsSync(c));
}

function simpleGlobMatch(pattern, filepath) {
  // Handle **/ meaning "zero or more directories"
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*\//g, "{{GLOBSTAR_SLASH}}")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR_SLASH\}\}/g, "(.+/)?")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regexStr}$`).test(filepath);
}

function matchesAnyInclude(testFile) {
  for (const pattern of VITEST_INCLUDES) {
    if (simpleGlobMatch(pattern, testFile)) {
      return true;
    }
  }
  return false;
}

function main() {
  const testFiles = walkDir(ROOT);
  console.log(`Found ${testFiles.length} test files\n`);

  const brokenImports = [];
  const uncoveredFiles = [];

  for (const file of testFiles) {
    const content = fs.readFileSync(path.join(ROOT, file), "utf8");
    const imports = extractImports(content);

    for (const imp of imports) {
      if (!resolveImport(file, imp)) {
        brokenImports.push({ file, import: imp });
      }
    }

    if (!matchesAnyInclude(file)) {
      uncoveredFiles.push(file);
    }
  }

  if (brokenImports.length === 0 && uncoveredFiles.length === 0) {
    console.log("No orphan tests found.");
    process.exit(0);
  }

  if (brokenImports.length > 0) {
    console.log(`=== Broken imports (${brokenImports.length}) ===`);
    for (const { file, import: imp } of brokenImports) {
      console.log(`  ${file}`);
      console.log(`    → ${imp}`);
    }
  }

  if (uncoveredFiles.length > 0) {
    console.log(`\n=== Not covered by any vitest config (${uncoveredFiles.length}) ===`);
    for (const file of uncoveredFiles) {
      console.log(`  ${file}`);
    }
  }

  process.exit(brokenImports.length > 0 ? 1 : 0);
}

main();
