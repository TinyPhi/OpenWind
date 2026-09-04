/**
 * outcome.ts — centralized AuditAction -> allowed/denied classification.
 *
 * ADR-012 Phase F, spec §V — this is the ONE place action-name semantics are
 * classified. Every new AuditAction value must be added here in the same
 * commit that adds it to the union in index.ts, mirroring the established
 * "extend the TS union + the DB CHECK constraint in the same commit" rule.
 */

import type { AuditAction } from "./index.js";

export type AuditOutcome = "allowed" | "denied";

// PR #489 review, F-04 -- `Record<AuditAction, true>` forces a TypeScript
// error if any AuditAction union member is missing here, unlike a plain
// `readonly AuditAction[]` (which the array below satisfies whether or not
// it's exhaustive). A future action added to the union but forgotten here
// would otherwise silently classify as "allowed" (classifyOutcome falls
// through to the default) with no compile-time or test signal.
const ALL_AUDIT_ACTIONS_EXHAUSTIVE: Record<AuditAction, true> = {
  created: true,
  updated: true,
  deleted: true,
  transitioned: true,
  restored: true,
  "purge.completed": true,
  "purge.failed": true,
  "tag.resolved_existing_access": true,
  "tag.auto_granted": true,
  "tag.access_request_created": true,
  "tag.fallback": true,
  "tag.resolution_failed": true,
  "tag.misuse_rate_capped": true,
  "transition.executed": true,
  "transition.access_denied": true,
  "comment.created": true,
  "comment.access_denied": true,
  "child.created": true,
  "child.access_denied": true,
  "attachment.referenced": true,
  "attachment.reference_denied": true,
  // Genuinely missing before this exhaustiveness check existed (F-04 caught
  // it immediately on introduction) -- ADR-012 Phase D's AV-scan outcomes,
  // merged via PR #475. Classified "allowed" below: neither represents a
  // third-party caller's request being denied -- they're an async worker's
  // own system/status outcome on a file already accepted for upload.
  "attachment.quarantined": true,
  "attachment.scan_failed": true,
  // Phase F follow-up, migration 0089 -- read endpoints' own audit actions.
  "ticket.viewed": true,
  "ticket.view_denied": true,
  "ticket.listed": true,
  "workflow.listed": true,
  "workflow_fields.listed": true,
  "attachment.downloaded": true,
  "attachment.download_denied": true,
};

// Object.keys() widens to string[] -- safe to narrow back since
// ALL_AUDIT_ACTIONS_EXHAUSTIVE's own type already guarantees its keys are
// exactly the AuditAction union, nothing more or less.
export const ALL_AUDIT_ACTIONS: readonly AuditAction[] = Object.keys(
  ALL_AUDIT_ACTIONS_EXHAUSTIVE,
) as AuditAction[];

// tag.fallback and tag.resolution_failed classify as "allowed", not
// "denied" (PR #489 review, S-01): neither represents an access decision
// that was actively refused -- fallback means the mention simply didn't
// resolve to anyone, and resolution_failed is a lookup error, not a denial.
// Only tag.misuse_rate_capped is a real denial among the tag.* actions.
const DENIED_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  "tag.misuse_rate_capped",
  "transition.access_denied",
  "comment.access_denied",
  "child.access_denied",
  "attachment.reference_denied",
  "ticket.view_denied",
  "attachment.download_denied",
]);

/**
 * Classifies an AuditAction as "allowed" or "denied". Denial is a semantic
 * property of the action, not a naming convention — e.g. `tag.misuse_rate_capped`
 * is a denial despite not ending in `.access_denied` or `.denied`.
 */
export function classifyOutcome(action: AuditAction): AuditOutcome {
  return DENIED_ACTIONS.has(action) ? "denied" : "allowed";
}

/** The full set of AuditAction values classified under the given outcome — used to build an `outcome` DB filter (outcome itself is derived, never stored). */
export function actionsForOutcome(outcome: AuditOutcome): AuditAction[] {
  return ALL_AUDIT_ACTIONS.filter((a) => classifyOutcome(a) === outcome);
}
