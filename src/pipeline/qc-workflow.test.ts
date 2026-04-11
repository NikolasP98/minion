import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {},
}));

import type { QcThresholds } from "./qc-config.js";
import { ensureQcSchema, getBatch, getBatchAlerts, getBatchInspections } from "./qc-db.js";
import { generateBatchReport } from "./qc-report.js";
import { classifyResult, processInspection, type InspectResult } from "./qc-workflow.js";

const THRESHOLDS: QcThresholds = {
  passThreshold: 0.95,
  failThreshold: 0.7,
  batchSize: 3,
};

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureQcSchema(db);
});

afterEach(() => {
  db.close();
});

// ── classifyResult ──────────────────────────────────────────────────────────

describe("classifyResult", () => {
  it("routes pass when sidecar says pass=true with high confidence", () => {
    const result: InspectResult = { defectType: "none", confidence: 0.98, boundingBox: null, pass: true };
    expect(classifyResult(result, THRESHOLDS)).toBe("pass");
  });

  it("routes fail when sidecar says pass=false with confidence >= failThreshold", () => {
    const result: InspectResult = {
      defectType: "crack",
      confidence: 0.85,
      boundingBox: { x: 10, y: 20, w: 50, h: 50 },
      pass: false,
    };
    expect(classifyResult(result, THRESHOLDS)).toBe("fail");
  });

  it("routes review when pass=true but confidence below passThreshold", () => {
    const result: InspectResult = { defectType: "none", confidence: 0.9, boundingBox: null, pass: true };
    expect(classifyResult(result, THRESHOLDS)).toBe("review");
  });

  it("routes review when pass=false but confidence below failThreshold", () => {
    const result: InspectResult = { defectType: "scratch", confidence: 0.5, boundingBox: null, pass: false };
    expect(classifyResult(result, THRESHOLDS)).toBe("review");
  });

  it("routes pass at exact passThreshold boundary", () => {
    const result: InspectResult = { defectType: "none", confidence: 0.95, boundingBox: null, pass: true };
    expect(classifyResult(result, THRESHOLDS)).toBe("pass");
  });

  it("routes fail at exact failThreshold boundary", () => {
    const result: InspectResult = { defectType: "dent", confidence: 0.7, boundingBox: null, pass: false };
    expect(classifyResult(result, THRESHOLDS)).toBe("fail");
  });
});

// ── processInspection ───────────────────────────────────────────────────────

describe("processInspection", () => {
  it("creates a batch and persists a pass inspection", () => {
    const result: InspectResult = { defectType: "none", confidence: 0.98, boundingBox: null, pass: true };
    const output = processInspection(db, result, "frame-001.png", THRESHOLDS);

    expect(output.routing).toBe("pass");
    expect(output.quarantine).toBe(false);
    expect(output.alertFired).toBe(false);
    expect(output.batchClosed).toBe(false);

    const batch = getBatch(db, output.batchId);
    expect(batch).toBeDefined();
    expect(batch!.pass_count).toBe(1);
    expect(batch!.total_inspections).toBe(1);
  });

  it("fires alert and sets quarantine on fail", () => {
    const alertHandler = vi.fn();
    const result: InspectResult = { defectType: "crack", confidence: 0.9, boundingBox: null, pass: false };
    const output = processInspection(db, result, "frame-002.png", THRESHOLDS, alertHandler);

    expect(output.routing).toBe("fail");
    expect(output.quarantine).toBe(true);
    expect(output.alertFired).toBe(true);
    expect(alertHandler).toHaveBeenCalledOnce();
    expect(alertHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        defectType: "crack",
        confidence: 0.9,
      }),
    );

    const alerts = getBatchAlerts(db, output.batchId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.defect_type).toBe("crack");
  });

  it("routes review items without alerts", () => {
    const alertHandler = vi.fn();
    const result: InspectResult = { defectType: "scratch", confidence: 0.5, boundingBox: null, pass: false };
    const output = processInspection(db, result, "frame-003.png", THRESHOLDS, alertHandler);

    expect(output.routing).toBe("review");
    expect(output.quarantine).toBe(false);
    expect(output.alertFired).toBe(false);
    expect(alertHandler).not.toHaveBeenCalled();
  });

  it("closes batch when batchSize is reached", () => {
    const items: InspectResult[] = [
      { defectType: "none", confidence: 0.98, boundingBox: null, pass: true },
      { defectType: "none", confidence: 0.97, boundingBox: null, pass: true },
      { defectType: "none", confidence: 0.99, boundingBox: null, pass: true },
    ];

    let lastOutput;
    for (let i = 0; i < items.length; i++) {
      lastOutput = processInspection(db, items[i]!, `frame-${i}.png`, THRESHOLDS);
    }

    expect(lastOutput!.batchClosed).toBe(true);
    const batch = getBatch(db, lastOutput!.batchId);
    expect(batch!.status).toBe("closed");
  });

  it("creates new batch after previous one closes", () => {
    const passResult: InspectResult = { defectType: "none", confidence: 0.98, boundingBox: null, pass: true };

    // Fill first batch (batchSize = 3)
    let firstBatchId: string | undefined;
    for (let i = 0; i < 3; i++) {
      const out = processInspection(db, passResult, `frame-${i}.png`, THRESHOLDS);
      firstBatchId = out.batchId;
    }

    // Next inspection should create a new batch
    const output = processInspection(db, passResult, "frame-4.png", THRESHOLDS);
    expect(output.batchId).not.toBe(firstBatchId);
  });
});

// ── Report Generation ───────────────────────────────────────────────────────

describe("generateBatchReport", () => {
  it("returns null for nonexistent batch", () => {
    expect(generateBatchReport(db, "nonexistent")).toBeNull();
  });

  it("generates report with correct metrics", () => {
    const items: InspectResult[] = [
      { defectType: "none", confidence: 0.98, boundingBox: null, pass: true },
      { defectType: "crack", confidence: 0.85, boundingBox: null, pass: false },
      { defectType: "scratch", confidence: 0.5, boundingBox: null, pass: false },
    ];

    let batchId: string | undefined;
    for (let i = 0; i < items.length; i++) {
      const out = processInspection(db, items[i]!, `frame-${i}.png`, THRESHOLDS);
      batchId = out.batchId;
    }

    const report = generateBatchReport(db, batchId!);
    expect(report).not.toBeNull();
    expect(report!.summary.totalInspections).toBe(3);
    expect(report!.summary.passCount).toBe(1);
    expect(report!.summary.failCount).toBe(1);
    expect(report!.summary.reviewCount).toBe(1);
    expect(report!.summary.defectRate).toBeCloseTo(1 / 3, 4);
    expect(report!.summary.alertCount).toBe(1);
    expect(report!.defectLog).toHaveLength(3);
    expect(report!.defectBreakdown).toHaveLength(1);
    expect(report!.defectBreakdown[0]!.defectType).toBe("crack");
  });

  it("generates report with empty batch", () => {
    const passResult: InspectResult = { defectType: "none", confidence: 0.98, boundingBox: null, pass: true };
    const out = processInspection(db, passResult, "frame-0.png", THRESHOLDS);
    // Remove the inspection to simulate empty (get the batch first)
    db.prepare(`DELETE FROM qc_inspections WHERE batch_id = ?`).run(out.batchId);
    db.prepare(`UPDATE qc_batches SET total_inspections = 0, pass_count = 0 WHERE id = ?`).run(out.batchId);

    const report = generateBatchReport(db, out.batchId);
    expect(report).not.toBeNull();
    expect(report!.summary.totalInspections).toBe(0);
    expect(report!.summary.defectRate).toBe(0);
  });
});
