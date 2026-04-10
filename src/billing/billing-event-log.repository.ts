import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// ── Domain types ─────────────────────────────────────────────────────────────

export type BillingEventStatus = "pending" | "emitted" | "failed" | "retrying" | "buffered";
export type OutcomeKind = "success" | "partial";

export interface OutcomeBillingEvent {
  id: string;
  customerId: string;
  taskId: string;
  agentId: string;
  outcomeDefinitionId: string;
  outcomeDefinitionVersionId: string;
  amount: number; // cents
  currency: "usd";
  outcome: OutcomeKind;
  detectedAt: Date;
  stripeMeterName: string | null;
  stripeEventId: string | null;
  idempotencyKey: string; // `${taskId}:${outcomeDefinitionId}`
  status: BillingEventStatus;
  retryCount: number;
  lastError: string | null;
  nextRetryAt: Date | null;
  emittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateBillingEventParams {
  customerId: string;
  taskId: string;
  agentId: string;
  outcomeDefinitionId: string;
  outcomeDefinitionVersionId: string;
  amount: number;
  outcome: OutcomeKind;
  detectedAt: Date;
  stripeMeterName: string | null;
  idempotencyKey: string;
}

// ── Raw DB row (all columns as returned by node:sqlite) ───────────────────────

interface BillingEventRow {
  id: string;
  customer_id: string;
  task_id: string;
  agent_id: string;
  outcome_definition_id: string;
  outcome_definition_version_id: string;
  amount: number;
  currency: string;
  outcome: string;
  detected_at: string;
  stripe_meter_name: string | null;
  stripe_event_id: string | null;
  idempotency_key: string;
  status: string;
  retry_count: number;
  last_error: string | null;
  next_retry_at: string | null;
  emitted_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToEvent(row: BillingEventRow): OutcomeBillingEvent {
  return {
    id: row.id,
    customerId: row.customer_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    outcomeDefinitionId: row.outcome_definition_id,
    outcomeDefinitionVersionId: row.outcome_definition_version_id,
    amount: row.amount,
    currency: "usd",
    outcome: row.outcome as OutcomeKind,
    detectedAt: new Date(row.detected_at),
    stripeMeterName: row.stripe_meter_name,
    stripeEventId: row.stripe_event_id,
    idempotencyKey: row.idempotency_key,
    status: row.status as BillingEventStatus,
    retryCount: row.retry_count,
    lastError: row.last_error,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at) : null,
    emittedAt: row.emitted_at ? new Date(row.emitted_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ── Repository ────────────────────────────────────────────────────────────────

/**
 * DB access layer for the `outcome_billing_events` table.
 * All methods are synchronous (node:sqlite DatabaseSync).
 *
 * Schema is applied by migration 002_billing_event_log.sql.
 */
export class BillingEventLogRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(params: CreateBillingEventParams): OutcomeBillingEvent {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO outcome_billing_events (
          id, customer_id, task_id, agent_id,
          outcome_definition_id, outcome_definition_version_id,
          amount, currency, outcome, detected_at,
          stripe_meter_name, stripe_event_id,
          idempotency_key, status, retry_count,
          last_error, next_retry_at, emitted_at,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?,
          ?, 'usd', ?, ?,
          ?, NULL,
          ?, 'pending', 0,
          NULL, NULL, NULL,
          ?, ?
        )`,
      )
      .run(
        id,
        params.customerId,
        params.taskId,
        params.agentId,
        params.outcomeDefinitionId,
        params.outcomeDefinitionVersionId,
        params.amount,
        params.outcome,
        params.detectedAt.toISOString(),
        params.stripeMeterName,
        params.idempotencyKey,
        now,
        now,
      );

    const row = this.db
      .prepare(`SELECT * FROM outcome_billing_events WHERE id = ?`)
      .get(id) as unknown as BillingEventRow;

    return rowToEvent(row);
  }

  findByIdempotencyKey(idempotencyKey: string): OutcomeBillingEvent | null {
    const row = this.db
      .prepare(`SELECT * FROM outcome_billing_events WHERE idempotency_key = ?`)
      .get(idempotencyKey) as unknown as BillingEventRow | undefined;

    return row ? rowToEvent(row) : null;
  }

  markEmitted(id: string, stripeEventId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE outcome_billing_events
         SET status = 'emitted', stripe_event_id = ?, emitted_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(stripeEventId, now, now, id);
  }

  markBuffered(id: string, lastError: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE outcome_billing_events
         SET status = 'buffered', last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(lastError, now, id);
  }

  scheduleRetry(id: string, backoffMinutes: number, lastError: string): void {
    const now = new Date();
    const nextRetryAt = new Date(now.getTime() + backoffMinutes * 60 * 1000).toISOString();

    this.db
      .prepare(
        `UPDATE outcome_billing_events
         SET status = 'retrying',
             retry_count = retry_count + 1,
             last_error = ?,
             next_retry_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(lastError, nextRetryAt, now.toISOString(), id);
  }

  findDueRetries(): OutcomeBillingEvent[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM outcome_billing_events
         WHERE status = 'retrying' AND next_retry_at <= ?
         ORDER BY next_retry_at ASC`,
      )
      .all(now) as unknown as BillingEventRow[];

    return rows.map(rowToEvent);
  }
}
