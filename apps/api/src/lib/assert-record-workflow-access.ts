import { eq, and } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityInstances } from "@platform/db";
import { isWorkflowAdmin, getWorkflow } from "@platform/workflow-engine";
import type { WorkflowCaller } from "@platform/workflow-engine";
import { EntityError } from "@platform/entity-engine";

// Global admin/agent already bypass this at the route layer (requireRole).
// For a plain "user" caller, full access to a record (creating a sub-ticket
// under it, linking it to another ticket) requires being that record's
// creator or assignee, OR an admin (creator/assigned_to) of the record's
// workflow — the same "full access" model the admin-ui's record-detail page
// uses to decide whether to show Link/sub-task-creation UI at all.
export async function assertRecordWorkflowAccess(
  tx: DbOrTx,
  tenantId: string,
  parentId: string,
  caller: WorkflowCaller,
): Promise<void> {
  const [parent] = await tx
    .select({
      id: entityInstances.id,
      workflowId: entityInstances.workflowId,
      createdBy: entityInstances.createdBy,
      assignedTo: entityInstances.assignedTo,
    })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, parentId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!parent)
    throw new EntityError("ENTITY_NOT_FOUND", { instanceId: parentId });

  if (
    parent.createdBy === caller.userId ||
    parent.assignedTo === caller.userId
  ) {
    return;
  }

  if (!parent.workflowId) {
    throw new EntityError("ENTITY_NOT_FOUND", { instanceId: parentId });
  }

  const workflow = await getWorkflow(tx, tenantId, parent.workflowId, caller);
  if (!isWorkflowAdmin(caller.userId, workflow)) {
    throw new EntityError("ENTITY_NOT_FOUND", { instanceId: parentId });
  }
}
