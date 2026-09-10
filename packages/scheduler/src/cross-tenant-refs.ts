/**
 * Cross-tenant reference validation for schedule_rules --
 * docs/temporal-scheduler-design.md §1.1/§1.3, R10b (reuses packages/teams'
 * shared validateCrossTenantRefs/lookupValidIdsInTable rather than a second
 * implementation, per the cross-track reuse principle T44 established).
 *
 * entity_type_id and workflow_id both allow a NULL-tenant row (global/system
 * template), matching entity_types.tenant_id / workflows.tenant_id's
 * nullable "system template" semantics (db-conventions.md, ADR-007) -- the
 * standard lookupValidIdsInTable helper assumes an exact tenant match, so
 * both get the same bespoke-lookup treatment as notification-policies.ts's
 * workflowTypeId check.
 */

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  entityTypes,
  workflows,
  teams,
  services,
  tenantUsers,
} from "@platform/db";
import type { DbOrTx } from "@platform/db";
import {
  validateCrossTenantRefs,
  lookupValidIdsInTable,
  type FieldError,
} from "@platform/teams";
import type { Template } from "./template.js";

export type ScheduleRuleRefInput = {
  entityTypeId: string;
  workflowId?: string | undefined;
  template: Pick<Template, "team_id" | "service_id" | "assignee_id">;
};

async function nullTenantAwareLookup(
  tx: DbOrTx,
  table: typeof entityTypes | typeof workflows,
  tenantId: string,
  refIds: string[],
): Promise<Set<string>> {
  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        inArray(table.id, refIds),
        or(eq(table.tenantId, tenantId), isNull(table.tenantId)),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

export async function validateScheduleRuleRefs(
  tx: DbOrTx,
  tenantId: string,
  input: ScheduleRuleRefInput,
): Promise<{ field: string; message: string }[]> {
  const errors: { field: string; message: string }[] = [];

  // entity_type_id: must resolve (own tenant or global template) AND have
  // name = 'ticket' (out of scope: "Auto-creation of any entity type other
  // than ticket", §C).
  const [entityType] = await tx
    .select({ id: entityTypes.id, name: entityTypes.name })
    .from(entityTypes)
    .where(
      and(
        eq(entityTypes.id, input.entityTypeId),
        or(eq(entityTypes.tenantId, tenantId), isNull(entityTypes.tenantId)),
      ),
    )
    .limit(1);
  if (!entityType) {
    errors.push({
      field: "entityTypeId",
      message: "Referenced resource does not exist or is not accessible",
    });
  } else if (entityType.name !== "ticket") {
    errors.push({
      field: "entityTypeId",
      message: "entityTypeId must reference the ticket entity type",
    });
  }

  if (input.workflowId) {
    const workflowErrors = await validateCrossTenantRefs(
      [{ fieldName: "workflowId", refId: input.workflowId }],
      (refIds) => nullTenantAwareLookup(tx, workflows, tenantId, refIds),
    );
    errors.push(
      ...workflowErrors.map((e: FieldError) => ({
        field: e.field,
        message: e.message,
      })),
    );
  }

  if (input.template.team_id) {
    const lookup = lookupValidIdsInTable(
      tx,
      teams,
      teams.id,
      teams.tenantId,
      teams.deletedAt,
      tenantId,
    );
    const teamErrors = await validateCrossTenantRefs(
      [{ fieldName: "template.team_id", refId: input.template.team_id }],
      lookup,
    );
    errors.push(
      ...teamErrors.map((e: FieldError) => ({
        field: e.field,
        message: e.message,
      })),
    );
  }

  if (input.template.service_id) {
    const lookup = lookupValidIdsInTable(
      tx,
      services,
      services.id,
      services.tenantId,
      services.deletedAt,
      tenantId,
    );
    const serviceErrors = await validateCrossTenantRefs(
      [
        {
          fieldName: "template.service_id",
          refId: input.template.service_id,
        },
      ],
      lookup,
    );
    errors.push(
      ...serviceErrors.map((e: FieldError) => ({
        field: e.field,
        message: e.message,
      })),
    );
  }

  if (input.template.assignee_id) {
    const lookup = lookupValidIdsInTable(
      tx,
      tenantUsers,
      tenantUsers.userId,
      tenantUsers.tenantId,
      undefined, // tenant_users has no soft-delete column
      tenantId,
    );
    const assigneeErrors = await validateCrossTenantRefs(
      [
        {
          fieldName: "template.assignee_id",
          refId: input.template.assignee_id,
        },
      ],
      lookup,
    );
    errors.push(
      ...assigneeErrors.map((e: FieldError) => ({
        field: e.field,
        message: e.message,
      })),
    );
  }

  return errors;
}
