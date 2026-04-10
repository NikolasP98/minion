import type Stripe from "stripe";
import type { SubsystemLogger } from "../logging/subsystem.js";
import type {
  BillingEventLogRepository,
  OutcomeBillingEvent,
} from "./billing-event-log.repository.js";
import { resolveMeterName } from "./outcome-meter-map.js";

// ── Public interfaces ─────────────────────────────────────────────────────────

/**
 * Subset of OutcomeDetector's detection result needed for billing.
 * Kept narrow to avoid coupling the billing module to the full detector API.
 */
export interface OutcomeDetectionResult {
  taskId: string;
  agentId: string;
  customerId: string;
  outcome: "success" | "partial";
  confidence: number;
  detectedAt: Date;
}

/**
 * The outcome definition record from the DB (subset of columns used here).
 */
export interface OutcomeDefinition {
  id: string;
  versionId: string;
  templateKey: string;
  pricePerOutcome: number; // cents
  partialBillingRate: number; // 0.0 – 1.0 multiplier for partial outcomes
  confidenceThreshold: number; // e.g. 0.85
}

export interface BillingEmitResult {
  success: boolean;
  stripeEventId: string | null;
  error: string | null;
}

// ── Exponential backoff schedule (minutes) ────────────────────────────────────

const RETRY_BACKOFF_MINUTES = [5, 15, 60, 240, 1440] as const;
const MAX_RETRIES = RETRY_BACKOFF_MINUTES.length; // 5 attempts before buffering

// ── BillingEventEmitter ───────────────────────────────────────────────────────

/**
 * Emits outcome billing events to Stripe metered billing.
 *
 * Core guarantees:
 *  - Idempotency: same taskId+outcomeDefinitionId is never emitted twice.
 *  - Retry: Stripe failures are scheduled with exponential backoff (5m→15m→1h→4h→24h).
 *  - Exhaustion: after 5 retries, event is buffered and a logger.error alert is raised.
 *  - Fire-and-forget: callers should NOT await this; catch any thrown promises separately.
 */
export class BillingEventEmitter {
  constructor(
    private readonly stripe: Stripe,
    private readonly billingEventLogRepo: BillingEventLogRepository,
    private readonly logger: SubsystemLogger,
  ) {}

  /**
   * Called by OutcomeDetector after confident detection (confidence ≥ confidenceThreshold).
   * Idempotent: duplicate calls with same taskId+outcomeDefinitionId are no-ops.
   */
  async emitOutcomeEvent(
    detection: OutcomeDetectionResult,
    definition: OutcomeDefinition,
  ): Promise<BillingEmitResult> {
    const idempotencyKey = `${detection.taskId}:${definition.id}`;
    const meterName = resolveMeterName(definition.templateKey);

    if (!meterName) {
      this.logger.warn("No Stripe meter mapped for template key", {
        templateKey: definition.templateKey,
        taskId: detection.taskId,
      });
      return {
        success: false,
        stripeEventId: null,
        error: `Unmapped template key: ${definition.templateKey}`,
      };
    }

    const amount =
      detection.outcome === "partial"
        ? Math.round(definition.pricePerOutcome * definition.partialBillingRate)
        : definition.pricePerOutcome;

    // ── Idempotency check ───────────────────────────────────────────────────
    const existing = this.billingEventLogRepo.findByIdempotencyKey(idempotencyKey);
    if (existing?.status === "emitted") {
      return { success: true, stripeEventId: existing.stripeEventId, error: null };
    }

    // ── Create pending event log entry ─────────────────────────────────────
    const event = this.billingEventLogRepo.create({
      customerId: detection.customerId,
      taskId: detection.taskId,
      agentId: detection.agentId,
      outcomeDefinitionId: definition.id,
      outcomeDefinitionVersionId: definition.versionId,
      amount,
      outcome: detection.outcome,
      detectedAt: detection.detectedAt,
      stripeMeterName: meterName,
      idempotencyKey,
    });

    return this.emitToStripe(event, meterName, detection.customerId, amount, detection.detectedAt);
  }

  /**
   * Retry processor — called by a background cron job every ~5 minutes.
   * Processes all events with status='retrying' whose next_retry_at is in the past.
   */
  async processRetries(): Promise<void> {
    const dueRetries = this.billingEventLogRepo.findDueRetries();

    for (const event of dueRetries) {
      if (!event.stripeMeterName || !event.customerId) {
        continue;
      }
      await this.emitToStripe(
        event,
        event.stripeMeterName,
        event.customerId,
        event.amount,
        event.detectedAt,
      );
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async emitToStripe(
    event: OutcomeBillingEvent,
    meterName: string,
    customerId: string,
    amountCents: number,
    detectedAt: Date,
  ): Promise<BillingEmitResult> {
    try {
      const meterEvent = await this.stripe.billing.meterEvents.create(
        {
          event_name: meterName,
          payload: {
            stripe_customer_id: customerId,
            value: String(amountCents),
          },
          timestamp: Math.floor(detectedAt.getTime() / 1000),
          identifier: event.idempotencyKey,
        },
        { idempotencyKey: event.idempotencyKey },
      );

      this.billingEventLogRepo.markEmitted(event.id, meterEvent.identifier);
      this.logger.info("Billing event emitted", {
        eventId: event.id,
        meterName,
        stripeIdentifier: meterEvent.identifier,
      });

      return { success: true, stripeEventId: meterEvent.identifier, error: null };
    } catch (err) {
      await this.scheduleRetry(event, err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { success: false, stripeEventId: null, error: errorMessage };
    }
  }

  private async scheduleRetry(event: OutcomeBillingEvent, err: unknown): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (event.retryCount >= MAX_RETRIES) {
      this.billingEventLogRepo.markBuffered(event.id, errorMessage);
      this.logger.error(
        "Billing event buffered after retry exhaustion — manual intervention required",
        {
          eventId: event.id,
          idempotencyKey: event.idempotencyKey,
          retryCount: event.retryCount,
          lastError: errorMessage,
        },
      );
      return;
    }

    const backoffMinutes = RETRY_BACKOFF_MINUTES[Math.min(event.retryCount, MAX_RETRIES - 1)];
    this.billingEventLogRepo.scheduleRetry(event.id, backoffMinutes, errorMessage);
    this.logger.warn("Billing event scheduled for retry", {
      eventId: event.id,
      retryCount: event.retryCount + 1,
      backoffMinutes,
      error: errorMessage,
    });
  }
}
