import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-protected-" });
installCronTestHooks({ logger });

function createCronService(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("CronService protected jobs", () => {
  it("allows update on unprotected job", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const job = await cron.add({
        name: "unprotected",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
      });

      const updated = await cron.update(job.id, { name: "unprotected-renamed" });
      expect(updated.name).toBe("unprotected-renamed");
    } finally {
      cron.stop();
    }
  });

  it("allows remove on unprotected job", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const job = await cron.add({
        name: "unprotected-remove",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
      });

      const result = await cron.remove(job.id);
      expect(result.removed).toBe(true);
    } finally {
      cron.stop();
    }
  });

  it("rejects update on protected job", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const job = await cron.add({
        name: "system-heartbeat",
        enabled: true,
        protected: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
      });

      await expect(cron.update(job.id, { name: "hacked" })).rejects.toThrow(
        /protected and cannot be updated/,
      );
      // Job should be unchanged
      expect(cron.getJob(job.id)?.name).toBe("system-heartbeat");
    } finally {
      cron.stop();
    }
  });

  it("rejects partial update on protected job", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const job = await cron.add({
        name: "system-job",
        enabled: true,
        protected: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
      });

      await expect(
        cron.update(job.id, { payload: { kind: "systemEvent", text: "injected" } }),
      ).rejects.toThrow(/protected and cannot be updated/);
    } finally {
      cron.stop();
    }
  });

  it("rejects remove on protected job", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const job = await cron.add({
        name: "system-job-remove",
        enabled: true,
        protected: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
      });

      await expect(cron.remove(job.id)).rejects.toThrow(/protected and cannot be deleted/);
      // Job should still exist
      expect(cron.getJob(job.id)).toBeDefined();
    } finally {
      cron.stop();
    }
  });

  it("persists protected flag in store", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();
    let jobId: string;

    try {
      const job = await cron.add({
        name: "persistent-protected",
        enabled: true,
        protected: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
      });
      jobId = job.id;
      expect(cron.getJob(jobId)?.protected).toBe(true);
    } finally {
      cron.stop();
    }

    // Reload from store and verify flag survives restart
    const cron2 = createCronService(storePath);
    await cron2.start();
    try {
      expect(cron2.getJob(jobId)?.protected).toBe(true);
      await expect(cron2.update(jobId, { name: "tampered" })).rejects.toThrow(
        /protected and cannot be updated/,
      );
    } finally {
      cron2.stop();
    }
  });
});
