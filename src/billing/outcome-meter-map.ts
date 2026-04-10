/**
 * Maps outcome definition template keys to Stripe meter event names.
 *
 * Finance decisions confirmed by CCO Apr 10, 2026 (see MIN-346 plan).
 * Template key (left) = OutcomeDefinition.templateKey in the DB.
 * Stripe meter name (right) = meter event_name used in billing.meterEvents.create().
 */
export const OUTCOME_METER_MAP: Readonly<Record<string, string>> = {
  "customer-support-resolution": "outcome_resolution",
  "code-review-completed": "outcome_code_review",
  "research-summary-delivered": "outcome_research_summary",
  "sales-meeting-booked": "outcome_sales_meeting",
  "data-extraction-complete": "outcome_data_extraction",
};

/**
 * Resolves the Stripe meter name for a given outcome definition template key.
 * Returns undefined if the key is not mapped (no billing event should be emitted).
 */
export function resolveMeterName(templateKey: string): string | undefined {
  return OUTCOME_METER_MAP[templateKey];
}
