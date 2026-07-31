import type { DbOrTx } from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import type { TriggerEvent } from "../event-schemas.js";
import type { CreateEntityConfig } from "../types.js";

export type { CreateEntityConfig };

// No `depth` parameter: unlike updateEntity's entity.assigned outbox payload,
// createEntity's entity.created payload doesn't carry automation recursion
// depth (see #218) — a self-triggering create_entity rule is bounded only by
// outbox throughput, not MAX_DEPTH, until that's fixed.
export async function executeCreateEntityAction(
  db: DbOrTx,
  tenantId: string,
  _event: TriggerEvent,
  config: CreateEntityConfig,
): Promise<void> {
  await createEntity(db, tenantId, {
    entityTypeId: config.entityTypeId,
    fields: config.fields ?? {},
    ...(config.assignedTo !== undefined && { assignedTo: config.assignedTo }),
  });
}
