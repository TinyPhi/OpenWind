// Pure rejection logic for vendor-approval-demo.ts, kept out of the script so
// it can be unit-tested (the script runs main() on import).

export const REVIEW_STATES = [
  "it_security_review",
  "legal_review",
  "pending_final_approval",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** Who rejects at each review stage, and the demo comment they leave. */
export const REJECTORS: Readonly<
  Record<ReviewState, { role: string; comment: string }>
> = {
  it_security_review: {
    role: "it_security",
    comment: "Vendor could not provide a current SOC 2 report or equivalent.",
  },
  legal_review: {
    role: "legal",
    comment: "Liability cap in the draft contract is below our minimum.",
  },
  pending_final_approval: {
    role: "finance_approver",
    comment: "Spend is not in this quarter's approved budget.",
  },
};

export function isReviewState(state: string): state is ReviewState {
  return (REVIEW_STATES as readonly string[]).includes(state);
}

/**
 * The review stage to reject at now, or null to keep advancing. A "rejected"
 * fixture rejects at `rejectAt`, or at the current stage when a resumed vendor
 * is already past it, so it never walks on to approval.
 */
export function rejectionStageFor(
  state: string,
  advanceTo: string,
  rejectAt: ReviewState,
): ReviewState | null {
  if (advanceTo !== "rejected" || !isReviewState(state)) return null;
  return REVIEW_STATES.indexOf(state) >= REVIEW_STATES.indexOf(rejectAt)
    ? state
    : null;
}
