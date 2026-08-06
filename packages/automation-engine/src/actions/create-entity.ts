import type { DbOrTx } from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import type { TriggerEvent } from "../event-schemas.js";
import type { CreateEntityConfig } from "../types.js";

export type { CreateEntityConfig };

export async function executeCreateEntityAction(
  db: DbOrTx,
  tenantId: string,
  _event: TriggerEvent,
  config: CreateEntityConfig,
  depth: number,
): Promise<void> {
  await createEntity(db, tenantId, {
    entityTypeId: config.entityTypeId,
    fields: config.fields ?? {},
    ...(config.assignedTo !== undefined && { assignedTo: config.assignedTo }),
    depth,
  });
}
