import type { DbOrTx } from "@platform/db";
import {
  getWorkflowByEntityTypeId,
  isWorkflowAdmin,
} from "@platform/workflow-engine";
import { EntityError } from "@platform/entity-engine";
import type { WorkflowCaller } from "@platform/workflow-engine";

// Field config lives on entity_types, but a workflow's admins (creator +
// assigned_to) should have full access to it — not just global admin.
// Throws (404, matching the platform's hide-existence convention) when the
// caller isn't a global admin and isn't an admin of the workflow that owns
// this entity type.
export async function assertFieldWorkflowAccess(
  tx: DbOrTx,
  tenantId: string,
  entityTypeId: string,
  caller: WorkflowCaller,
): Promise<void> {
  if (caller.isGlobalAdmin) return;

  const workflow = await getWorkflowByEntityTypeId(tx, tenantId, entityTypeId);
  if (!workflow || !isWorkflowAdmin(caller.userId, workflow)) {
    throw new EntityError("FIELD_NOT_FOUND", { entityTypeId });
  }
}
