import type { DbOrTx } from "@platform/db";
import { getWorkflow } from "./workflow-crud.js";
import { isWorkflowAdmin } from "./authorization.js";

// Moved here from apps/api/src/lib/entity-access.ts (ADR-012 Phase C) so
// apps/worker's mention-resolution processor can reach the same ticket-access
// check apps/api uses, without violating the apps/* -> packages/* dependency
// rule (apps/worker cannot import from apps/api). workflow-engine is the
// right home, not entity-engine, since these functions need
// getWorkflow/isWorkflowAdmin and entity-engine -> db only.
// apps/api/src/lib/entity-access.ts now just re-exports this module so its
// existing call sites are unaffected.

/**
 * Shared record-level read-access check for entity instances gated by the
 * __accessUsers field ACL (see create-attachment.ts / add-comment.ts for the
 * sibling write-side checks this mirrors). Does NOT consider workflow-admin
 * status — that requires a DB lookup, see hasEntityAccess below.
 */
export function hasEntityReadAccess(
  instance: {
    createdBy: string | null;
    assignedTo: string | null;
    fields: unknown;
  },
  userId: string,
  roles: string[],
): boolean {
  if (roles.includes("admin") || roles.includes("agent")) return true;
  if (instance.createdBy === userId || instance.assignedTo === userId) {
    return true;
  }

  const accessUsers =
    (instance.fields as Record<string, unknown> | null)?.__accessUsers ?? {};
  const level = (accessUsers as Record<string, { level: string }>)[userId]
    ?.level;
  return (
    level === "read_only" || level === "read_comment" || level === "read_write"
  );
}

/**
 * Explicit ticket access list — createdBy + assignedTo + __accessUsers keys,
 * unioned with the given creator id. Deliberately excludes org-wide
 * admin/agent role access (hasEntityReadAccess's role check): a "notify
 * everyone with access" ticket alert should reach the people actually tied to
 * this ticket, not every admin/agent in the tenant. See docs/specs/ticket-alerts.md §R4.
 */
export function explicitAccessListUserIds(
  instance: {
    createdBy: string | null;
    assignedTo: string | null;
    fields: unknown;
  },
  unionUserId: string,
): string[] {
  const ids = new Set<string>();
  if (instance.createdBy) ids.add(instance.createdBy);
  if (instance.assignedTo) ids.add(instance.assignedTo);

  const accessUsers =
    (instance.fields as Record<string, unknown> | null)?.__accessUsers ?? {};
  if (Array.isArray(accessUsers)) {
    for (const uid of accessUsers as string[]) ids.add(uid);
  } else if (typeof accessUsers === "object") {
    for (const uid of Object.keys(accessUsers as Record<string, unknown>)) {
      ids.add(uid);
    }
  }

  ids.add(unionUserId);
  return Array.from(ids);
}

/**
 * Comment-level access check — stricter than hasEntityReadAccess: a caller
 * whose only __accessUsers grant is "read_only" can view the record but not
 * comment on it (only "read_comment"/"read_write" or ownership qualify).
 * Extracted from add-comment.ts's original inline check (ADR-012 Phase C,
 * spec R2) so the human-UI comment route and the third-party comment
 * endpoint share one definition instead of two independently maintained
 * copies.
 */
export function hasEntityCommentAccess(
  instance: {
    createdBy: string | null;
    assignedTo: string | null;
    fields: unknown;
  },
  userId: string,
  roles: string[],
): boolean {
  if (roles.includes("admin") || roles.includes("agent")) return true;
  if (instance.createdBy === userId || instance.assignedTo === userId) {
    return true;
  }

  const accessUsers =
    (instance.fields as Record<string, unknown> | null)?.__accessUsers ?? {};
  const level = (accessUsers as Record<string, { level: string }>)[userId]
    ?.level;
  return level === "read_comment" || level === "read_write";
}

/**
 * Full record-level access check: hasEntityReadAccess plus "is the caller an
 * admin (creator or assigned_to) of this record's workflow" — a workflow
 * admin gets full access to every record in their workflow, not just ones
 * they're personally the creator/assignee/ACL-listed on. Use this instead of
 * hasEntityReadAccess wherever the instance's workflowId is available.
 */
export async function hasEntityAccess(
  tx: DbOrTx,
  tenantId: string,
  instance: {
    createdBy: string | null;
    assignedTo: string | null;
    fields: unknown;
    workflowId: string | null;
  },
  userId: string,
  roles: string[],
): Promise<boolean> {
  if (hasEntityReadAccess(instance, userId, roles)) return true;
  if (!instance.workflowId) return false;

  const workflow = await getWorkflow(tx, tenantId, instance.workflowId, {
    userId,
    isGlobalAdmin: false,
  });
  return isWorkflowAdmin(userId, workflow);
}

/**
 * Full comment-access check: hasEntityCommentAccess plus workflow-admin
 * fallback, mirroring hasEntityAccess's shape but gated on comment-level
 * access rather than mere read access. Use this wherever the instance's
 * workflowId is available (ADR-012 Phase C, spec R1/R2).
 */
export async function hasEntityCommentAccessFull(
  tx: DbOrTx,
  tenantId: string,
  instance: {
    createdBy: string | null;
    assignedTo: string | null;
    fields: unknown;
    workflowId: string | null;
  },
  userId: string,
  roles: string[],
): Promise<boolean> {
  if (hasEntityCommentAccess(instance, userId, roles)) return true;
  if (!instance.workflowId) return false;

  const workflow = await getWorkflow(tx, tenantId, instance.workflowId, {
    userId,
    isGlobalAdmin: false,
  });
  return isWorkflowAdmin(userId, workflow);
}
