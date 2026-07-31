import type { DbOrTx } from "@platform/db";
import { updateEntity } from "@platform/entity-engine";
import type { TriggerEvent } from "../event-schemas.js";
import type { AssignConfig } from "../types.js";

export type { AssignConfig };

export async function executeAssignAction(
  db: DbOrTx,
  tenantId: string,
  event: TriggerEvent,
  config: AssignConfig,
  depth: number,
): Promise<void> {
  const instanceId =
    config.instanceId ?? ("instanceId" in event ? event.instanceId : undefined);
  if (!instanceId) return;

  await updateEntity(db, tenantId, instanceId, {
    assignedTo: config.assigneeId,
    depth,
  });
}
