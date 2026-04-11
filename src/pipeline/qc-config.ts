/**
 * QC workflow configuration — threshold settings for defect classification.
 *
 * Confidence thresholds determine how inspection results are routed:
 * - >= passThreshold → pass (continue production)
 * - <= failThreshold → fail (alert + quarantine)
 * - between failThreshold and passThreshold → needs-review (human-in-loop)
 *
 * @module
 */

import { z } from "zod";

// ── Schema ──────────────────────────────────────────────────────────────────

export const QcThresholdsSchema = z
  .object({
    /**
     * Confidence at or above which the item passes.
     * Note: this applies to the sidecar's `pass` field confidence.
     * When the sidecar says pass=true AND confidence >= passThreshold, we pass.
     * When the sidecar says pass=false AND confidence >= failThreshold, we fail.
     */
    passThreshold: z.number().min(0).max(1).default(0.95),
    /** Confidence at or below which the item definitively fails. */
    failThreshold: z.number().min(0).max(1).default(0.7),
    /** Maximum items per batch before auto-closing the batch. */
    batchSize: z.number().int().positive().default(100),
  })
  .refine((t) => t.failThreshold < t.passThreshold, {
    message: "failThreshold must be less than passThreshold",
  });

export type QcThresholds = z.infer<typeof QcThresholdsSchema>;

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_QC_THRESHOLDS: QcThresholds = {
  passThreshold: 0.95,
  failThreshold: 0.7,
  batchSize: 100,
};

/**
 * Load QC thresholds from environment or return defaults.
 *
 * Env vars: QC_PASS_THRESHOLD, QC_FAIL_THRESHOLD, QC_BATCH_SIZE
 */
export function loadQcThresholds(): QcThresholds {
  const raw = {
    passThreshold: process.env.QC_PASS_THRESHOLD
      ? Number(process.env.QC_PASS_THRESHOLD)
      : DEFAULT_QC_THRESHOLDS.passThreshold,
    failThreshold: process.env.QC_FAIL_THRESHOLD
      ? Number(process.env.QC_FAIL_THRESHOLD)
      : DEFAULT_QC_THRESHOLDS.failThreshold,
    batchSize: process.env.QC_BATCH_SIZE
      ? Number(process.env.QC_BATCH_SIZE)
      : DEFAULT_QC_THRESHOLDS.batchSize,
  };
  return QcThresholdsSchema.parse(raw);
}
