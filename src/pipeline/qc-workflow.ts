/**
 * QC Agent Workflow — defect classification, pass/fail routing, and alert triggering.
 *
 * Workflow:
 * 1. Receive frame (base64 image) from camera integration
 * 2. Call POST /api/inspect via the ViT inference sidecar
 * 3. Classify result based on configurable confidence thresholds:
 *    - pass: sidecar says pass=true AND confidence >= passThreshold
 *    - fail: sidecar says pass=false AND confidence >= failThreshold
 *    - review: everything else (low-confidence results go to human-in-loop)
 * 4. Route: pass → continue, fail → alert + quarantine flag, review → human queue
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { logError, logInfo, logWarn } from "../logger.js";
import type { QcThresholds } from "./qc-config.js";
import {
  closeBatch,
  createBatch,
  getBatch,
  getOpenBatch,
  insertAlert,
  insertInspection,
  type QcRouting,
} from "./qc-db.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Raw result from the ViT inference sidecar (/api/inspect response). */
export type InspectResult = {
  defectType: string;
  confidence: number;
  boundingBox: { x: number; y: number; w: number; h: number } | null;
  pass: boolean;
};

/** Result of a single QC inspection through the workflow. */
export type QcInspectionResult = {
  inspectionId: string;
  batchId: string;
  routing: QcRouting;
  defectType: string;
  confidence: number;
  quarantine: boolean;
  alertFired: boolean;
  batchClosed: boolean;
};

/** Alert callback — invoked when a fail detection triggers an alert. */
export type AlertHandler = (alert: {
  inspectionId: string;
  batchId: string;
  defectType: string;
  confidence: number;
  message: string;
}) => void;

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Classify an inspection result into pass/fail/review based on thresholds.
 *
 * Logic:
 * - If the sidecar says pass=true and confidence >= passThreshold → "pass"
 * - If the sidecar says pass=false and confidence >= failThreshold → "fail"
 * - Otherwise → "review" (human-in-loop)
 */
export function classifyResult(result: InspectResult, thresholds: QcThresholds): QcRouting {
  if (result.pass && result.confidence >= thresholds.passThreshold) {
    return "pass";
  }
  if (!result.pass && result.confidence >= thresholds.failThreshold) {
    return "fail";
  }
  return "review";
}

// ── Workflow Execution ──────────────────────────────────────────────────────

/**
 * Process a single frame through the QC workflow.
 *
 * 1. Ensures an open batch exists (creates one if needed)
 * 2. Classifies the inspection result
 * 3. Persists the inspection record
 * 4. If fail: creates alert + fires alertHandler
 * 5. If batch is full: closes batch
 */
export function processInspection(
  db: DatabaseSync,
  result: InspectResult,
  imageRef: string,
  thresholds: QcThresholds,
  alertHandler?: AlertHandler,
): QcInspectionResult {
  // Ensure open batch
  let batch = getOpenBatch(db);
  if (!batch) {
    const batchId = randomUUID();
    createBatch(db, batchId);
    batch = getBatch(db, batchId)!;
    logInfo(`qc-workflow: Created new batch ${batchId}`);
  }

  // Classify
  const routing = classifyResult(result, thresholds);
  const inspectionId = randomUUID();

  // Persist inspection
  insertInspection(db, {
    id: inspectionId,
    batch_id: batch.id,
    image_ref: imageRef,
    defect_type: result.defectType,
    confidence: result.confidence,
    bounding_box: result.boundingBox ? JSON.stringify(result.boundingBox) : null,
    routing,
    raw_pass: result.pass ? 1 : 0,
  });

  // Handle routing
  let alertFired = false;
  const quarantine = routing === "fail";

  if (routing === "fail") {
    const message = `DEFECT DETECTED: ${result.defectType} (confidence: ${(result.confidence * 100).toFixed(1)}%) — item quarantined`;
    insertAlert(db, {
      id: randomUUID(),
      batch_id: batch.id,
      inspection_id: inspectionId,
      defect_type: result.defectType,
      confidence: result.confidence,
      message,
    });
    alertFired = true;
    logWarn(`qc-workflow: ${message}`);

    if (alertHandler) {
      alertHandler({
        inspectionId,
        batchId: batch.id,
        defectType: result.defectType,
        confidence: result.confidence,
        message,
      });
    }
  } else if (routing === "review") {
    logInfo(
      `qc-workflow: Item sent to review queue — ${result.defectType} (confidence: ${(result.confidence * 100).toFixed(1)}%)`,
    );
  } else {
    logInfo(`qc-workflow: Item passed — confidence ${(result.confidence * 100).toFixed(1)}%`);
  }

  // Check if batch should be closed
  const updatedBatch = getBatch(db, batch.id)!;
  let batchClosed = false;
  if (updatedBatch.total_inspections >= thresholds.batchSize) {
    closeBatch(db, batch.id);
    batchClosed = true;
    logInfo(`qc-workflow: Batch ${batch.id} closed (${updatedBatch.total_inspections} inspections)`);
  }

  return {
    inspectionId,
    batchId: batch.id,
    routing,
    defectType: result.defectType,
    confidence: result.confidence,
    quarantine,
    alertFired,
    batchClosed,
  };
}
