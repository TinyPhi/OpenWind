import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { workflows } from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import type { TriggerEvent } from "../event-schemas.js";
import type { CreateEntityConfig } from "../types.js";
import { resolveTicketValues } from "./ticket-template.js";

export type { CreateEntityConfig };

/**
 * The entity type's active workflow -- the tenant's own before a global template -- whose
 * owner is the fallback assignee. Null when the type has none: its records aren't tickets.
 */
async function workflowOfType(
  db: DbOrTx,
  tenantId: string,
  entityTypeId: string,
): Promise<string | null> {
  // The tenant's own workflow wins over a global template.
  const [row] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.entityTypeId, entityTypeId),
        or(eq(workflows.tenantId, tenantId), isNull(workflows.tenantId)),
        eq(workflows.isActive, true),
      ),
    )
    // false (the tenant's own workflow) sorts before true (a global template).
    .orderBy(sql`${workflows.tenantId} IS NULL`)
    .limit(1);
  return row?.id ?? null;
}

/**
 * create_entity action. A ticket (a record of a type with a workflow) always carries the
 * four mandatory values (docs/specs/mandatory-ticket-fields.md R7): from the rule's
 * template, else the defaults in ticket-template.ts. Records of other types are created as
 * before.
 */
export async function executeCreateEntityAction(
  db: DbOrTx,
  tenantId: string,
  _event: TriggerEvent,
  config: CreateEntityConfig,
  depth: number,
  ruleName: string,
): Promise<void> {
  const fields = config.fields ?? {};
  const workflowId = await workflowOfType(db, tenantId, config.entityTypeId);
  if (!workflowId) {
    await createEntity(db, tenantId, {
      entityTypeId: config.entityTypeId,
      fields,
      ...(config.assignedTo !== undefined && { assignedTo: config.assignedTo }),
      depth,
    });
    return;
  }

  const values = await resolveTicketValues(db, tenantId, {
    template: config.template,
    ruleName,
    fieldsTitle: fields["title"],
    defaultTitle: ruleName,
    legacyAssignee: config.assignedTo,
    workflowId,
  });

  await createEntity(db, tenantId, {
    entityTypeId: config.entityTypeId,
    fields: { ...fields, title: values.title },
    dueDate: values.dueDate,
    remark: values.remark,
    severity: values.severity,
    ...(values.assignedTo !== undefined && { assignedTo: values.assignedTo }),
    ...(values.teamId !== undefined && { teamId: values.teamId }),
    depth,
  });
}
