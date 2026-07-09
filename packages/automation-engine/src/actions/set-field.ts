import type { DbOrTx } from "@platform/db";
import { updateEntity } from "@platform/entity-engine";
import type { TriggerEvent } from "../event-schemas.js";
import type { SetFieldConfig } from "../types.js";

export type { SetFieldConfig };

export async function executeSetFieldAction(
  db: DbOrTx,
  tenantId: string,
  event: TriggerEvent,
  config: SetFieldConfig,
  depth: number,
): Promise<void> {
  const instanceId =
    config.instanceId ?? ("instanceId" in event ? event.instanceId : undefined);
  if (!instanceId) return;

  await updateEntity(db, tenantId, instanceId, {
    fields: { [config.field]: config.value },
    depth,
  });
}
