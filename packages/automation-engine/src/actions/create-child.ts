import type { DbOrTx } from "@platform/db";
import {
  getEntity,
  updateEntity,
  createChildRelation,
} from "@platform/entity-engine";
import type { TriggerEvent } from "../event-schemas.js";
import type { CreateChildConfig } from "../types.js";

export type { CreateChildConfig };

/**
 * Interpolates `{{fieldName}}` placeholders in `template` from `fields`.
 * An unmatched or missing field becomes an empty string rather than leaving
 * the literal placeholder in — the resulting text is shown directly to the
 * child ticket's assignee (e.g. tender's costing analyst), who has no way to
 * resolve a stray `{{summary}}` back to the source field.
 */
function interpolateTemplate(
  template: string,
  fields: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = fields[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

/**
 * create_child action (#162): creates a child ticket under the triggering
 * event's instance via the existing, unmodified parent-child mechanism
 * (packages/entity-engine/src/child-relations.ts::createChildRelation) —
 * this handler is purely a thin automation-config wrapper around it, per
 * modules/tender/README.md's "Known gap" note (option 1).
 *
 * `entityTypeId` defaults to the parent's own entity type when omitted —
 * the module seed configs that need this action today (tender's costing
 * child) create a same-type child, isolated from the parent by field
 * selection (only descriptionTemplate's interpolated text is copied, never
 * the parent's other fields) and by assignment, not by a different type.
 *
 * Idempotency guard: when `writeBackField` is set and already has a value on
 * the parent, skip — do not create a second child. This can't be enforced
 * via the rule's own condition tree: executor.ts only merges an event's
 * `fields` map into condition-matching data for entity.created triggers;
 * workflow.transitioned (what tender's rule fires on) carries no field
 * values at all, so a `{"op": "empty", "field": "costing_child_id"}`
 * condition can never see the parent's real current value and would always
 * pass. Checking here, against the parent loaded directly from the DB, is
 * what actually delivers "exactly-once child creation" (README's R9).
 */
export async function executeCreateChildAction(
  db: DbOrTx,
  tenantId: string,
  event: TriggerEvent,
  config: CreateChildConfig,
  depth: number,
): Promise<void> {
  const parentId =
    "instanceId" in event ? (event.instanceId as string) : undefined;
  if (!parentId) return;

  const parent = await getEntity(db, tenantId, parentId);

  if (config.writeBackField) {
    const existing = parent.fields[config.writeBackField];
    if (existing !== undefined && existing !== null && existing !== "") {
      return;
    }
  }

  const entityTypeId = config.entityTypeId ?? parent.entityTypeId;

  const childFields: Record<string, unknown> = { ...(config.fields ?? {}) };
  if (config.descriptionTemplate) {
    const descriptionField = config.descriptionField ?? "description";
    childFields[descriptionField] = interpolateTemplate(
      config.descriptionTemplate,
      parent.fields,
    );
  }

  const { instance: child } = await createChildRelation(db, tenantId, {
    parentId,
    childFields,
    entityTypeId,
    ...(config.assignToUserId ? { assignedTo: config.assignToUserId } : {}),
  });

  if (config.writeBackField) {
    await updateEntity(db, tenantId, parentId, {
      fields: { [config.writeBackField]: child.id },
      depth,
    });
  }
}
