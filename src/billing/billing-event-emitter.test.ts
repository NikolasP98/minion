import { describe, expect, it, vi } from "vitest";
import type { OutcomeDefinition, OutcomeDetectionResult } from "./billing-event-emitter.js";
import type {
  CreateBillingEventParams,
  OutcomeBillingEvent,
} from "./billing-event-log.repository.js";

// ── Minimal SubsystemLogger mock ──────────────────────────────────────────────

function makeLoggerMock() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
    subsystem: "billing",
    isEnabled: vi.fn().mockReturnValue(false),
  };
}

// ── Minimal Stripe mock ───────────────────────────────────────────────────────

function makeStripeMock(createFn?: ReturnType<typeof vi.fn>) {
  return {
    billing: {
      meterEvents: {
        create: createFn ?? vi.fn().mockResolvedValue({ identifier: "stripe-evt-abc123" }),
      },
    },
  };
}

// ── In-memory repo mock ───────────────────────────────────────────────────────

function makeEvent(
  params: CreateBillingEventParams,
  overrides?: Partial<OutcomeBillingEvent>,
): OutcomeBillingEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    customerId: params.customerId,
    taskId: params.taskId,
    agentId: params.agentId,
    outcomeDefinitionId: params.outcomeDefinitionId,
    outcomeDefinitionVersionId: params.outcomeDefinitionVersionId,
    amount: params.amount,
    currency: "usd",
    outcome: params.outcome,
    detectedAt: params.detectedAt,
    stripeMeterName: params.stripeMeterName,
    stripeEventId: null,
    idempotencyKey: params.idempotencyKey,
    status: "pending",
    retryCount: 0,
    lastError: null,
    nextRetryAt: null,
    emittedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRepoMock() {
  const store = new Map<string, OutcomeBillingEvent>();

  const create = vi.fn((params: CreateBillingEventParams): OutcomeBillingEvent => {
    const event = makeEvent(params);
    store.set(params.idempotencyKey, event);
    return event;
  });

  const findByIdempotencyKey = vi.fn((key: string): OutcomeBillingEvent | null => {
    return store.get(key) ?? null;
  });

  const markEmitted = vi.fn((id: string, stripeEventId: string): void => {
    for (const [, event] of store) {
      if (event.id === id) {
        (event as OutcomeBillingEvent & { status: string; stripeEventId: string | null }).status =
          "emitted";
        (
          event as OutcomeBillingEvent & { status: string; stripeEventId: string | null }
        ).stripeEventId = stripeEventId;
      }
    }
  });

  const markBuffered = vi.fn((id: string, lastError: string): void => {
    for (const [, event] of store) {
      if (event.id === id) {
        (event as OutcomeBillingEvent & { status: string; lastError: string | null }).status =
          "buffered";
        (event as OutcomeBillingEvent & { status: string; lastError: string | null }).lastError =
          lastError;
      }
    }
  });

  const scheduleRetry = vi.fn((id: string, _backoffMinutes: number, lastError: string): void => {
    for (const [, event] of store) {
      if (event.id === id) {
        (
          event as OutcomeBillingEvent & {
            status: string;
            retryCount: number;
            lastError: string | null;
          }
        ).status = "retrying";
        (
          event as OutcomeBillingEvent & {
            status: string;
            retryCount: number;
            lastError: string | null;
          }
        ).retryCount += 1;
        (
          event as OutcomeBillingEvent & {
            status: string;
            retryCount: number;
            lastError: string | null;
          }
        ).lastError = lastError;
      }
    }
  });

  const findDueRetries = vi.fn((): OutcomeBillingEvent[] => []);

  return {
    create,
    findByIdempotencyKey,
    markEmitted,
    markBuffered,
    scheduleRetry,
    findDueRetries,
    _store: store,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const detection: OutcomeDetectionResult = {
  taskId: "task-001",
  agentId: "agent-001",
  customerId: "cus_test123",
  outcome: "success",
  confidence: 0.95,
  detectedAt: new Date("2026-04-10T12:00:00Z"),
};

const definition: OutcomeDefinition = {
  id: "def-001",
  versionId: "ver-001",
  templateKey: "customer-support-resolution",
  pricePerOutcome: 500, // $5.00 in cents
  partialBillingRate: 0.5,
  confidenceThreshold: 0.85,
};

// ── Helper: build emitter under test ─────────────────────────────────────────

async function buildEmitter(overrides?: { stripeCreate?: ReturnType<typeof vi.fn> }) {
  const { BillingEventEmitter } = await import("./billing-event-emitter.js");
  const stripe = makeStripeMock(overrides?.stripeCreate);
  const repo = makeRepoMock();
  const logger = makeLoggerMock();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const emitter = new BillingEventEmitter(stripe as any, repo as any, logger as any);
  return { emitter, stripe, repo, logger };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BillingEventEmitter.emitOutcomeEvent", () => {
  // ── Test 1: successful emit ─────────────────────────────────────────────────
  it("successful emit → result.success=true, stripeEventId set, DB marked emitted", async () => {
    const { emitter, repo } = await buildEmitter();

    const result = await emitter.emitOutcomeEvent(detection, definition);

    expect(result.success).toBe(true);
    expect(result.stripeEventId).toBe("stripe-evt-abc123");
    expect(result.error).toBeNull();
    expect(repo.create).toHaveBeenCalledOnce();
    expect(repo.markEmitted).toHaveBeenCalledWith(expect.any(String), "stripe-evt-abc123");
  });

  // ── Test 2: idempotency ─────────────────────────────────────────────────────
  it("second call with same idempotency key returns existing result, no Stripe call made", async () => {
    const { emitter, stripe, repo } = await buildEmitter();

    // First call — succeeds and marks emitted
    await emitter.emitOutcomeEvent(detection, definition);

    // Simulate repo returning an already-emitted event for second call
    const emittedEvent: OutcomeBillingEvent = makeEvent(
      {
        customerId: detection.customerId,
        taskId: detection.taskId,
        agentId: detection.agentId,
        outcomeDefinitionId: definition.id,
        outcomeDefinitionVersionId: definition.versionId,
        amount: definition.pricePerOutcome,
        outcome: detection.outcome,
        detectedAt: detection.detectedAt,
        stripeMeterName: "outcome_resolution",
        idempotencyKey: `${detection.taskId}:${definition.id}`,
      },
      { status: "emitted", stripeEventId: "stripe-evt-abc123" },
    );
    repo.findByIdempotencyKey.mockReturnValueOnce(emittedEvent);

    const secondResult = await emitter.emitOutcomeEvent(detection, definition);

    expect(secondResult.success).toBe(true);
    expect(secondResult.stripeEventId).toBe("stripe-evt-abc123");
    // Stripe must NOT be called again
    expect(stripe.billing.meterEvents.create).toHaveBeenCalledOnce();
    // DB create must NOT be called again
    expect(repo.create).toHaveBeenCalledOnce();
  });

  // ── Test 3: Stripe error → retrying, backoff = 5 minutes ───────────────────
  it("Stripe error → scheduleRetry called with 5-minute initial backoff", async () => {
    const stripeCreate = vi.fn().mockRejectedValue(new Error("Stripe unavailable"));
    const { emitter, repo } = await buildEmitter({ stripeCreate });

    const result = await emitter.emitOutcomeEvent(detection, definition);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Stripe unavailable");
    expect(repo.scheduleRetry).toHaveBeenCalledWith(
      expect.any(String),
      5, // first backoff = 5 minutes
      expect.stringContaining("Stripe unavailable"),
    );
    expect(repo.markBuffered).not.toHaveBeenCalled();
  });

  // ── Test 4: retry exhaustion → buffered ────────────────────────────────────
  it("retry exhaustion after 5 failures → markBuffered called, logger.error raised", async () => {
    const stripeCreate = vi.fn().mockRejectedValue(new Error("persistent failure"));
    const { emitter, repo, logger } = await buildEmitter({ stripeCreate });

    // Build an exhausted event (retryCount = 5) for findDueRetries
    const exhaustedEvent: OutcomeBillingEvent = makeEvent(
      {
        customerId: "cus_test123",
        taskId: "task-001",
        agentId: "agent-001",
        outcomeDefinitionId: "def-001",
        outcomeDefinitionVersionId: "ver-001",
        amount: 500,
        outcome: "success",
        detectedAt: new Date(),
        stripeMeterName: "outcome_resolution",
        idempotencyKey: "task-001:def-001",
      },
      {
        id: "evt-exhausted",
        status: "retrying",
        retryCount: 5,
        nextRetryAt: new Date(Date.now() - 1000),
      },
    );

    repo.findDueRetries.mockReturnValueOnce([exhaustedEvent]);

    await emitter.processRetries();

    expect(repo.markBuffered).toHaveBeenCalledWith(
      "evt-exhausted",
      expect.stringContaining("persistent failure"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("buffered after retry exhaustion"),
      expect.objectContaining({ eventId: "evt-exhausted" }),
    );
    expect(repo.scheduleRetry).not.toHaveBeenCalled();
  });

  // ── Test 5: partial outcome → correct amount ────────────────────────────────
  it("partial outcome → amount = round(pricePerOutcome × partialBillingRate)", async () => {
    const { emitter, repo } = await buildEmitter();

    const partialDetection: OutcomeDetectionResult = { ...detection, outcome: "partial" };
    await emitter.emitOutcomeEvent(partialDetection, definition);

    const expectedAmount = Math.round(500 * 0.5); // 250 cents
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ amount: expectedAmount }));
  });

  // ── Test 6: outcome type → correct Stripe meter event_name ─────────────────
  it("templateKey maps to correct Stripe meter event_name", async () => {
    const { emitter, stripe } = await buildEmitter();

    // customer-support-resolution → outcome_resolution
    await emitter.emitOutcomeEvent(detection, definition);
    expect(stripe.billing.meterEvents.create).toHaveBeenCalledWith(
      expect.objectContaining({ event_name: "outcome_resolution" }),
      expect.anything(),
    );

    // code-review-completed → outcome_code_review
    const { emitter: emitter2, stripe: stripe2 } = await buildEmitter();
    await emitter2.emitOutcomeEvent(
      { ...detection, taskId: "task-002" },
      { ...definition, id: "def-002", templateKey: "code-review-completed" },
    );
    expect(stripe2.billing.meterEvents.create).toHaveBeenCalledWith(
      expect.objectContaining({ event_name: "outcome_code_review" }),
      expect.anything(),
    );
  });
});
