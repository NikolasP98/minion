/** Async JSON file I/O with atomic writes. For sync I/O, see ./json-file.ts */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options?: { mode?: number },
) {
  const mode = options?.mode ?? 0o600;
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    await fs.chmod(tmp, mode);
  } catch {
    // best-effort; ignore on platforms without chmod
  }
  await fs.rename(tmp, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // best-effort; ignore on platforms without chmod
  }
}

export { createAsyncLock } from "./async-lock.js";
