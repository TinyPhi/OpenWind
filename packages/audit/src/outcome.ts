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

export const ALL_AUDIT_ACTIONS: readonly AuditAction[] = [
  "created",
  "updated",
  "deleted",
  "transitioned",
  "restored",
  "purge.completed",
  "purge.failed",
  "tag.resolved_existing_access",
  "tag.auto_granted",
  "tag.access_request_created",
  "tag.fallback",
  "tag.resolution_failed",
  "tag.misuse_rate_capped",
  "transition.executed",
  "transition.access_denied",
  "comment.created",
  "comment.access_denied",
  "child.created",
  "child.access_denied",
  "attachment.referenced",
  "attachment.reference_denied",
];

const DENIED_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  "tag.misuse_rate_capped",
  "transition.access_denied",
  "comment.access_denied",
  "child.access_denied",
  "attachment.reference_denied",
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
