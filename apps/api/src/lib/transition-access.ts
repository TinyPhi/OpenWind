import type { DbOrTx } from "@platform/db";
import {
  getWorkflow,
  isWorkflowAdmin,
  WorkflowError,
} from "@platform/workflow-engine";

/**
 * ADR-012 Phase E — access check for third-party status transitions.
 *
 * Deliberately narrower than entity-access.ts's hasEntityAccess: creator,
 * assignee, or workflow-admin ONLY. Never consults __accessUsers, at any
 * tier, even read_write. Resolved 2026-08-14 as an intentional design
 * boundary, not a gap — granted/mentioned access was never meant to include
 * transition/edit rights, identically for API and human callers. Do not
 * reach for hasEntityAccess/hasEntityCommentAccessFull here; both treat any
 * __accessUsers level as sufficient, which would silently reopen the exact
 * boundary this phase exists to enforce.
 *
 * Returns false (never throws) ONLY on a WORKFLOW_NOT_FOUND race — the
 * workflow can be deleted between the instance fetch and this call (#184,
 * the same race already closed on the comment-post and attachment routes).
 * Callers fold a false return into the same 404 every other denial on the
 * route returns, so this race is indistinguishable from an ordinary access
 * denial. Every other error from getWorkflow (DB failure, timeout, etc.) is
 * re-thrown -- a blank catch-all here would turn a real infra failure into
 * a silent, unlogged 404 indistinguishable from a legitimate denial (PR #484
 * review, PrabhuVijit B-03). The caller must let this propagate to the
 * route-level error handler (a 500), not fold it into notFound().
 */
export async function hasTransitionAccess(
  tx: DbOrTx,
  tenantId: string,
  instance: {
    createdBy: string | null;
    assignedTo: string | null;
    workflowId: string | null;
  },
  userId: string,
): Promise<boolean> {
  if (instance.createdBy === userId || instance.assignedTo === userId) {
    return true;
  }
  if (!instance.workflowId) return false;

  try {
    const workflow = await getWorkflow(tx, tenantId, instance.workflowId, {
      userId,
      isGlobalAdmin: false,
    });
    return isWorkflowAdmin(userId, workflow);
  } catch (err) {
    if (err instanceof WorkflowError && err.code === "WORKFLOW_NOT_FOUND") {
      return false;
    }
    throw err;
  }
}
