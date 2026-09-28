#!/usr/bin/env tsx
/**
 * backfill-ticket-department.ts
 *
 * One-time fill for the `department` custom field (2026-09-21) on every
 * ticket created before that field existed. New tickets already get one
 * from the create form's dropdown going forward — this only catches the
 * backlog. Not a recurring job: once every ticket has a value, re-running
 * this finds nothing left to do and is a no-op.
 *
 * There is no real signal for what an existing ticket's department should
 * have been, so this makes its best guess from a field that already has
 * real values — `category` — then falls back to a random pick from
 * `department`'s own configured options for a ticket with no category
 * match. Documented here rather than hidden in the code so it's clear this
 * is a best-effort guess, not derived data:
 *   technical -> engineering
 *   billing   -> finance
 *   general   -> support
 *
 * Run:
 *   pnpm backfill:department
 */
import "dotenv/config";
import { eq, and, isNull, sql } from "drizzle-orm";
import {
  withTenantContext,
  entityInstances,
  entityTypes,
  entityFields,
} from "@platform/db";

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "00000000-0000-0000-0000-000000000001";

const CATEGORY_TO_DEPARTMENT: Record<string, string> = {
  technical: "engineering",
  billing: "finance",
  general: "support",
};

async function main(): Promise<void> {
  const [ticketType] = await withTenantContext(DEV_TENANT_ID, (tx) =>
    tx
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(
        and(
          eq(entityTypes.name, "ticket"),
          eq(entityTypes.tenantId, DEV_TENANT_ID),
        ),
      ),
  );
  if (!ticketType) {
    throw new Error(`No 'ticket' entity type for tenant ${DEV_TENANT_ID}`);
  }

  const [departmentField] = await withTenantContext(DEV_TENANT_ID, (tx) =>
    tx
      .select({ config: entityFields.config })
      .from(entityFields)
      .where(
        and(
          eq(entityFields.entityTypeId, ticketType.id),
          eq(entityFields.name, "department"),
        ),
      ),
  );
  if (!departmentField) {
    // Fails loudly rather than falling back to a hardcoded list — if the
    // field's own options ever change, this backfill should reflect that,
    // not drift from it silently.
    throw new Error(
      "No 'department' entity_fields row found — run the helpdesk seed " +
        "(or its manual equivalent for an already-installed tenant) first",
    );
  }
  const options = (departmentField.config as { options?: string[] } | null)
    ?.options;
  if (!options || options.length === 0) {
    throw new Error("'department' field has no configured options");
  }

  const rows = await withTenantContext(DEV_TENANT_ID, (tx) =>
    tx
      .select({
        id: entityInstances.id,
        fields: entityInstances.fields,
      })
      .from(entityInstances)
      .where(
        and(
          eq(entityInstances.entityTypeId, ticketType.id),
          eq(entityInstances.tenantId, DEV_TENANT_ID),
          isNull(entityInstances.deletedAt),
          sql`${entityInstances.fields}->>'department' IS NULL`,
        ),
      ),
  );

  if (rows.length === 0) {
    console.log("Nothing to backfill — every ticket already has a department.");
    return;
  }

  let updated = 0;
  for (const row of rows) {
    const fields = row.fields as Record<string, unknown>;
    const category =
      typeof fields["category"] === "string" ? fields["category"] : null;
    const department =
      (category && CATEGORY_TO_DEPARTMENT[category]) ||
      options[Math.floor(Math.random() * options.length)];

    await withTenantContext(DEV_TENANT_ID, (tx) =>
      tx
        .update(entityInstances)
        .set({ fields: { ...fields, department } })
        .where(eq(entityInstances.id, row.id)),
    );
    updated += 1;
  }

  console.log(`Backfilled department on ${updated} ticket(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
