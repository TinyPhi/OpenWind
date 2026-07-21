import { eq, and } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityInstances } from "@platform/db";
import { isWorkflowAdmin, getWorkflow } from "@platform/workflow-engine";
import type { WorkflowCaller } from "@platform/workflow-engine";
import { EntityError } from "@platform/entity-engine";

// Global admin/agent already bypass this at the route layer (requireRole).
// For a plain "user" caller, creating a sub-ticket under a parent requires
// being an admin (creator or assigned_to) of the parent's workflow — same
// "full workflow access" model as states/transitions/fields.
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
  if (!parent.workflowId) return; // no workflow — nothing to be admin of

  const workflow = await getWorkflow(tx, tenantId, parent.workflowId, caller);
  if (!isWorkflowAdmin(caller.userId, workflow)) {
    throw new EntityError("ENTITY_NOT_FOUND", { instanceId: parentId });
  }
}
