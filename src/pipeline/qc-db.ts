/**
 * QC pipeline SQLite schema — tables for batches, inspections, and alerts.
 *
 * Uses node:sqlite DatabaseSync alongside the existing pipeline schema.
 *
 * @module
 */

import type { DatabaseSync } from "node:sqlite";

// ── Types ────────────────────────────────────────────────────────────────────

export type QcRouting = "pass" | "fail" | "review";

export type InspectionRow = {
  id: string;
  batch_id: string;
  image_ref: string;
  defect_type: string | null;
  confidence: number;
  bounding_box: string | null;
  routing: QcRouting;
  raw_pass: number; // 0 or 1 (SQLite boolean)
  created_at: number;
};

export type BatchRow = {
  id: string;
  status: "open" | "closed";
  created_at: number;
  closed_at: number | null;
  total_inspections: number;
  pass_count: number;
  fail_count: number;
  review_count: number;
};

export type AlertRow = {
  id: string;
  batch_id: string;
  inspection_id: string;
  defect_type: string;
  confidence: number;
  message: string;
  created_at: number;
};

// ── Schema Creation ─────────────────────────────────────────────────────────

export function ensureQcSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qc_batches (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      closed_at INTEGER,
      total_inspections INTEGER NOT NULL DEFAULT 0,
      pass_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS qc_inspections (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES qc_batches(id),
      image_ref TEXT NOT NULL,
      defect_type TEXT,
      confidence REAL NOT NULL,
      bounding_box TEXT,
      routing TEXT NOT NULL,
      raw_pass INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_qc_inspections_batch ON qc_inspections(batch_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS qc_alerts (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES qc_batches(id),
      inspection_id TEXT NOT NULL REFERENCES qc_inspections(id),
      defect_type TEXT NOT NULL,
      confidence REAL NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_qc_alerts_batch ON qc_alerts(batch_id);
  `);
}

// ── Batch Operations ────────────────────────────────────────────────────────

export function createBatch(db: DatabaseSync, batchId: string): void {
  db.prepare(`INSERT INTO qc_batches (id, status, created_at) VALUES (?, 'open', ?)`).run(
    batchId,
    Date.now(),
  );
}

export function closeBatch(db: DatabaseSync, batchId: string): void {
  db.prepare(`UPDATE qc_batches SET status = 'closed', closed_at = ? WHERE id = ?`).run(
    Date.now(),
    batchId,
  );
}

export function getBatch(db: DatabaseSync, batchId: string): BatchRow | undefined {
  return db.prepare(`SELECT * FROM qc_batches WHERE id = ?`).get(batchId) as
    | BatchRow
    | undefined;
}

export function getOpenBatch(db: DatabaseSync): BatchRow | undefined {
  return db
    .prepare(`SELECT * FROM qc_batches WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`)
    .get() as BatchRow | undefined;
}

// ── Inspection Operations ───────────────────────────────────────────────────

export function insertInspection(
  db: DatabaseSync,
  row: Omit<InspectionRow, "created_at">,
): void {
  db.prepare(
    `INSERT INTO qc_inspections (id, batch_id, image_ref, defect_type, confidence, bounding_box, routing, raw_pass, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.batch_id,
    row.image_ref,
    row.defect_type,
    row.confidence,
    row.bounding_box,
    row.routing,
    row.raw_pass,
    Date.now(),
  );

  // Update batch counters
  const field =
    row.routing === "pass"
      ? "pass_count"
      : row.routing === "fail"
        ? "fail_count"
        : "review_count";
  db.prepare(
    `UPDATE qc_batches SET total_inspections = total_inspections + 1, ${field} = ${field} + 1 WHERE id = ?`,
  ).run(row.batch_id);
}

export function getBatchInspections(db: DatabaseSync, batchId: string): InspectionRow[] {
  return db
    .prepare(`SELECT * FROM qc_inspections WHERE batch_id = ? ORDER BY created_at ASC`)
    .all(batchId) as InspectionRow[];
}

// ── Alert Operations ────────────────────────────────────────────────────────

export function insertAlert(db: DatabaseSync, row: Omit<AlertRow, "created_at">): void {
  db.prepare(
    `INSERT INTO qc_alerts (id, batch_id, inspection_id, defect_type, confidence, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.batch_id, row.inspection_id, row.defect_type, row.confidence, row.message, Date.now());
}

export function getBatchAlerts(db: DatabaseSync, batchId: string): AlertRow[] {
  return db
    .prepare(`SELECT * FROM qc_alerts WHERE batch_id = ? ORDER BY created_at ASC`)
    .all(batchId) as AlertRow[];
}
