import type { DbOrTx } from "@platform/db";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";

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
