/**
 * Integration test scaffold for BillingEventEmitter (MIN-347).
 *
 * These tests are SKIPPED by default and require a Stripe test-mode API key.
 * They will be activated once Stripe test credentials arrive via board approval
 * (MIN-346 plan, pending approval 21d484a4).
 *
 * To run:
 *   STRIPE_TEST_API_KEY=sk_test_... pnpm vitest run src/billing/billing-integration.test.ts
 */

import { describe, expect, it } from "vitest";

const STRIPE_TEST_API_KEY = process.env["STRIPE_TEST_API_KEY"];
const shouldSkip = !STRIPE_TEST_API_KEY;

describe.skipIf(shouldSkip)(
  "BillingEventEmitter integration (requires STRIPE_TEST_API_KEY)",
  () => {
    it("emits a meter event to Stripe test mode and receives a valid identifier", async () => {
      // Dynamic imports so the module is not loaded in environments without stripe
      const { default: Stripe } = await import("stripe");
      const { BillingEventEmitter } = await import("./billing-event-emitter.js");
      const { createSubsystemLogger } = await import("../logging/subsystem.js");

      const stripe = new Stripe(STRIPE_TEST_API_KEY!, { apiVersion: "2026-03-25.dahlia" });
      const logger = createSubsystemLogger("billing-integration-test");

      // Use an in-memory stub repo for the integration test
      // (we only care about the Stripe round-trip, not the DB layer)
      const stubRepo = {
        create: (params: Parameters<typeof BillingEventEmitter.prototype.emitOutcomeEvent>[0]) => ({
          id: "integration-evt-001",
          customerId: (params as { customerId: string }).customerId,
          taskId: "integration-task-001",
          agentId: "integration-agent-001",
          outcomeDefinitionId: "integration-def-001",
          outcomeDefinitionVersionId: "integration-ver-001",
          amount: 100,
          currency: "usd" as const,
          outcome: "success" as const,
          detectedAt: new Date(),
          stripeMeterName: "outcome_resolution",
          stripeEventId: null,
          idempotencyKey: "integration-task-001:integration-def-001",
          status: "pending" as const,
          retryCount: 0,
          lastError: null,
          nextRetryAt: null,
          emittedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        findByIdempotencyKey: () => null,
        markEmitted: () => undefined,
        markBuffered: () => undefined,
        scheduleRetry: () => undefined,
        findDueRetries: () => [],
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const emitter = new BillingEventEmitter(stripe, stubRepo as any, logger);

      const result = await emitter.emitOutcomeEvent(
        {
          taskId: "integration-task-001",
          agentId: "integration-agent-001",
          customerId: "cus_test_integration",
          outcome: "success",
          confidence: 0.95,
          detectedAt: new Date(),
        },
        {
          id: "integration-def-001",
          versionId: "integration-ver-001",
          templateKey: "customer-support-resolution",
          pricePerOutcome: 100,
          partialBillingRate: 0.5,
          confidenceThreshold: 0.85,
        },
      );

      // Stripe in test mode should return a valid identifier
      expect(result.success).toBe(true);
      expect(result.stripeEventId).toBeTruthy();
      expect(result.error).toBeNull();
    });
  },
);

// Placeholder so the file is not empty when STRIPE_TEST_API_KEY is absent
if (shouldSkip) {
  describe("BillingEventEmitter integration (skipped — STRIPE_TEST_API_KEY not set)", () => {
    it.skip("skipped: set STRIPE_TEST_API_KEY to run integration tests", () => {
      // intentionally empty
    });
  });
}
