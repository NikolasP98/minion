/**
 * QC inspection report generation.
 *
 * Generates per-batch reports with:
 * - Defect log (timestamp, defect type, confidence, image ref)
 * - Summary: defect rate %, false positive estimate, throughput metrics
 * - Defect type breakdown
 *
 * @module
 */

import type { DatabaseSync } from "node:sqlite";
import { getBatch, getBatchAlerts, getBatchInspections, type AlertRow, type InspectionRow } from "./qc-db.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type DefectLogEntry = {
  inspectionId: string;
  timestamp: number;
  defectType: string | null;
  confidence: number;
  imageRef: string;
  routing: string;
};

export type DefectTypeBreakdown = {
  defectType: string;
  count: number;
  percentage: number;
  avgConfidence: number;
};

export type BatchReportSummary = {
  totalInspections: number;
  passCount: number;
  failCount: number;
  reviewCount: number;
  defectRate: number;
  passRate: number;
  reviewRate: number;
  /** Estimated false positive rate — review items as proportion of total flagged. */
  estimatedFalsePositiveRate: number;
  /** Inspections per minute (if batch has start/end times). */
  throughputPerMinute: number | null;
  alertCount: number;
};

export type BatchReport = {
  batchId: string;
  batchStatus: string;
  generatedAt: number;
  summary: BatchReportSummary;
  defectBreakdown: DefectTypeBreakdown[];
  defectLog: DefectLogEntry[];
  alerts: AlertRow[];
};

// ── Report Generation ───────────────────────────────────────────────────────

/**
 * Generate an inspection report for a batch.
 *
 * Returns null if the batch doesn't exist.
 */
export function generateBatchReport(db: DatabaseSync, batchId: string): BatchReport | null {
  const batch = getBatch(db, batchId);
  if (!batch) return null;

  const inspections = getBatchInspections(db, batchId);
  const alerts = getBatchAlerts(db, batchId);

  const summary = buildSummary(inspections, alerts, batch.created_at, batch.closed_at);
  const defectBreakdown = buildDefectBreakdown(inspections);
  const defectLog = buildDefectLog(inspections);

  return {
    batchId,
    batchStatus: batch.status,
    generatedAt: Date.now(),
    summary,
    defectBreakdown,
    defectLog,
    alerts,
  };
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function buildSummary(
  inspections: InspectionRow[],
  alerts: AlertRow[],
  batchStartedAt: number,
  batchClosedAt: number | null,
): BatchReportSummary {
  const total = inspections.length;
  if (total === 0) {
    return {
      totalInspections: 0,
      passCount: 0,
      failCount: 0,
      reviewCount: 0,
      defectRate: 0,
      passRate: 0,
      reviewRate: 0,
      estimatedFalsePositiveRate: 0,
      throughputPerMinute: null,
      alertCount: 0,
    };
  }

  const passCount = inspections.filter((i) => i.routing === "pass").length;
  const failCount = inspections.filter((i) => i.routing === "fail").length;
  const reviewCount = inspections.filter((i) => i.routing === "review").length;

  const defectRate = failCount / total;
  const passRate = passCount / total;
  const reviewRate = reviewCount / total;

  // Estimated false positive rate: review items / (fail + review) — items flagged
  // but uncertain. 0 if no flagged items.
  const flaggedCount = failCount + reviewCount;
  const estimatedFalsePositiveRate = flaggedCount > 0 ? reviewCount / flaggedCount : 0;

  // Throughput: inspections per minute
  let throughputPerMinute: number | null = null;
  const endTime = batchClosedAt ?? (inspections.length > 0 ? inspections[inspections.length - 1]!.created_at : null);
  if (endTime && endTime > batchStartedAt) {
    const durationMinutes = (endTime - batchStartedAt) / 60_000;
    if (durationMinutes > 0) {
      throughputPerMinute = Math.round((total / durationMinutes) * 100) / 100;
    }
  }

  return {
    totalInspections: total,
    passCount,
    failCount,
    reviewCount,
    defectRate: Math.round(defectRate * 10000) / 10000,
    passRate: Math.round(passRate * 10000) / 10000,
    reviewRate: Math.round(reviewRate * 10000) / 10000,
    estimatedFalsePositiveRate: Math.round(estimatedFalsePositiveRate * 10000) / 10000,
    throughputPerMinute,
    alertCount: alerts.length,
  };
}

function buildDefectBreakdown(inspections: InspectionRow[]): DefectTypeBreakdown[] {
  const failedInspections = inspections.filter((i) => i.routing === "fail" && i.defect_type);

  if (failedInspections.length === 0) return [];

  const groups = new Map<string, { count: number; totalConfidence: number }>();
  for (const inspection of failedInspections) {
    const type = inspection.defect_type!;
    const existing = groups.get(type);
    if (existing) {
      existing.count++;
      existing.totalConfidence += inspection.confidence;
    } else {
      groups.set(type, { count: 1, totalConfidence: inspection.confidence });
    }
  }

  const totalFailed = failedInspections.length;
  return Array.from(groups.entries())
    .map(([defectType, { count, totalConfidence }]) => ({
      defectType,
      count,
      percentage: Math.round((count / totalFailed) * 10000) / 10000,
      avgConfidence: Math.round((totalConfidence / count) * 10000) / 10000,
    }))
    .sort((a, b) => b.count - a.count);
}

function buildDefectLog(inspections: InspectionRow[]): DefectLogEntry[] {
  return inspections.map((i) => ({
    inspectionId: i.id,
    timestamp: i.created_at,
    defectType: i.defect_type,
    confidence: i.confidence,
    imageRef: i.image_ref,
    routing: i.routing,
  }));
}
