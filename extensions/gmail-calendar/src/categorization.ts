/**
 * Smart email categorization.
 *
 * Provides rule-based priority/category tagging for incoming emails.
 * Used by auto-reply flows and inbox management tools to route mail.
 */

export type EmailCategory =
  | "urgent"
  | "action_required"
  | "newsletter"
  | "promotional"
  | "social"
  | "financial"
  | "calendar_invite"
  | "automated"
  | "personal"
  | "unknown";

export type EmailPriority = "high" | "medium" | "low";

export type CategorizationResult = {
  category: EmailCategory;
  priority: EmailPriority;
  suggestedLabel: string;
  reasoning: string;
};

type EmailMeta = {
  from?: string;
  subject?: string;
  body?: string;
  labels?: string[];
};

// ── Rule helpers ──────────────────────────────────────────────────────

const matchesAny = (text: string | undefined, patterns: RegExp[]): boolean => {
  if (!text) return false;
  return patterns.some((p) => p.test(text));
};

const NEWSLETTER_SENDERS = [
  /substack\.com$/i,
  /mailchimp\.com$/i,
  /sendgrid\.net$/i,
  /list-unsubscribe/i,
  /newsletter@/i,
  /noreply@/i,
  /no-reply@/i,
  /notifications@/i,
  /digest@/i,
];

const NEWSLETTER_SUBJECTS = [
  /weekly digest/i,
  /monthly roundup/i,
  /newsletter/i,
  /unsubscribe/i,
  /\bdigest\b/i,
];

const PROMOTIONAL_SUBJECTS = [
  /\bsale\b/i,
  /\bdiscount\b/i,
  /\boffer\b/i,
  /\bpromo(tion)?\b/i,
  /\bdeal\b/i,
  /\b\d+%\s*off\b/i,
  /\bfree\b.+\bshipping\b/i,
  /\bcoupon\b/i,
];

const URGENT_SUBJECTS = [
  /\burgent\b/i,
  /\basap\b/i,
  /\bimmediate(ly)?\b/i,
  /\bcritical\b/i,
  /\baction required\b/i,
  /\btime.?sensitive\b/i,
];

const ACTION_REQUIRED_SUBJECTS = [
  /\bplease review\b/i,
  /\bplease approve\b/i,
  /\bapproval needed\b/i,
  /\bplease sign\b/i,
  /\bresponse needed\b/i,
  /\bfeedback requested\b/i,
  /\bplease confirm\b/i,
  /\bfollow.?up\b/i,
];

const CALENDAR_SUBJECTS = [
  /\binvitation\b/i,
  /\bmeeting invite\b/i,
  /\bhas invited you\b/i,
  /\baccept or decline\b/i,
  /\bcalendar event\b/i,
];

const FINANCIAL_SUBJECTS = [
  /\binvoice\b/i,
  /\breceipt\b/i,
  /\bpayment\b/i,
  /\bbilling\b/i,
  /\btransaction\b/i,
  /\bstatement\b/i,
  /\bcharge\b/i,
  /\brefund\b/i,
];

const AUTOMATED_SENDERS = [
  /daemon@/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /alert@/i,
  /alerts@/i,
  /monitoring@/i,
  /support@/i,
];

const SOCIAL_SUBJECTS = [
  /\bconnected with you\b/i,
  /\bfollowed you\b/i,
  /\bmentioned you\b/i,
  /\bliked your\b/i,
  /\bcommented on\b/i,
  /\bnew message from\b/i,
];

// ── Classifier ────────────────────────────────────────────────────────

/**
 * Classify an email based on its metadata.
 * Returns a category, priority, suggested Gmail label, and brief reasoning.
 */
export function categorizeEmail(meta: EmailMeta): CategorizationResult {
  const { from = "", subject = "", labels = [] } = meta;

  // Calendar invite — check before other rules
  if (
    matchesAny(subject, CALENDAR_SUBJECTS) ||
    labels.some((l) => l.toLowerCase().includes("invite"))
  ) {
    return {
      category: "calendar_invite",
      priority: "high",
      suggestedLabel: "Calendar/Invites",
      reasoning: "Subject or labels match calendar invitation patterns.",
    };
  }

  // Urgent
  if (matchesAny(subject, URGENT_SUBJECTS)) {
    return {
      category: "urgent",
      priority: "high",
      suggestedLabel: "Priority/Urgent",
      reasoning: "Subject contains urgency keywords.",
    };
  }

  // Action required
  if (matchesAny(subject, ACTION_REQUIRED_SUBJECTS)) {
    return {
      category: "action_required",
      priority: "high",
      suggestedLabel: "Priority/Action",
      reasoning: "Subject requests action or review.",
    };
  }

  // Financial
  if (matchesAny(subject, FINANCIAL_SUBJECTS)) {
    return {
      category: "financial",
      priority: "medium",
      suggestedLabel: "Finance",
      reasoning: "Subject matches financial/billing patterns.",
    };
  }

  // Newsletter (sender-based first, then subject)
  if (matchesAny(from, NEWSLETTER_SENDERS) || matchesAny(subject, NEWSLETTER_SUBJECTS)) {
    return {
      category: "newsletter",
      priority: "low",
      suggestedLabel: "Newsletters",
      reasoning: "Sender or subject matches newsletter patterns.",
    };
  }

  // Promotional
  if (matchesAny(subject, PROMOTIONAL_SUBJECTS)) {
    return {
      category: "promotional",
      priority: "low",
      suggestedLabel: "Promotions",
      reasoning: "Subject matches promotional/marketing patterns.",
    };
  }

  // Social
  if (matchesAny(subject, SOCIAL_SUBJECTS)) {
    return {
      category: "social",
      priority: "low",
      suggestedLabel: "Social",
      reasoning: "Subject matches social network notification patterns.",
    };
  }

  // Automated
  if (matchesAny(from, AUTOMATED_SENDERS)) {
    return {
      category: "automated",
      priority: "low",
      suggestedLabel: "Automated",
      reasoning: "Sender address matches automated/system sender patterns.",
    };
  }

  // Default: personal
  return {
    category: "personal",
    priority: "medium",
    suggestedLabel: "Personal",
    reasoning: "No specific category matched; treating as personal mail.",
  };
}

/**
 * Summarize a batch of categorization results (for inbox overview).
 */
export function summarizeCategories(results: CategorizationResult[]): string {
  const counts: Record<string, number> = {};
  for (const r of results) {
    counts[r.category] = (counts[r.category] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([cat, n]) => `${cat}: ${n}`)
    .join(", ");
}
