/**
 * request-kind.ts — centralized AuditAction -> read/write classification.
 *
 * Mirrors outcome.ts's own exhaustiveness pattern exactly: every new
 * AuditAction value must be added to WRITE_ACTIONS or left to the default
 * "read" classification in the same commit that adds it to the union in
 * index.ts, per that file's own "extend the TS union + the DB CHECK
 * constraint in the same commit" rule.
 */

import type { AuditAction } from "./index.js";

export type AuditRequestKind = "read" | "write";

// Everything that isn't listed here classifies as "read" by
// classifyRequestKind's default branch -- explicit allow-list of the writes,
// not the reads, since new actions are far more often reads (list/describe/
// download endpoints) than mutations.
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
  "attachment.quarantined": true,
  "attachment.scan_failed": true,
  "ticket.viewed": true,
  "ticket.view_denied": true,
  "ticket.listed": true,
  "workflow.listed": true,
  "workflow_fields.listed": true,
  "attachment.downloaded": true,
  "attachment.download_denied": true,
};

export const ALL_AUDIT_ACTIONS_FOR_REQUEST_KIND: readonly AuditAction[] =
  Object.keys(ALL_AUDIT_ACTIONS_EXHAUSTIVE) as AuditAction[];

// Every action that represents a mutation attempt (allowed or denied) on
// tenant data. AV-scan outcomes (quarantined/scan_failed) are an async
// worker's own status update on an already-accepted upload, not a
// third-party caller's request -- classified "write" since they do mutate
// the attachment's state, but they never appear in the third-party access
// logs screen anyway (actor_type is 'system', not 'api_key', for those two).
const WRITE_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
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
  "attachment.quarantined",
  "attachment.scan_failed",
  "transition.executed",
  "transition.access_denied",
  "comment.created",
  "comment.access_denied",
  "child.created",
  "child.access_denied",
  "attachment.referenced",
  "attachment.reference_denied",
]);

/**
 * Classifies an AuditAction as a "read" (view/list/download, including a
 * denied attempt at one) or a "write" (create/update/transition/comment/
 * etc., including a denied attempt at one).
 */
export function classifyRequestKind(action: AuditAction): AuditRequestKind {
  return WRITE_ACTIONS.has(action) ? "write" : "read";
}

/** The full set of AuditAction values classified under the given kind -- used to build a `type` DB filter (kind itself is derived, never stored). */
export function actionsForRequestKind(kind: AuditRequestKind): AuditAction[] {
  return ALL_AUDIT_ACTIONS_FOR_REQUEST_KIND.filter(
    (a) => classifyRequestKind(a) === kind,
  );
}
