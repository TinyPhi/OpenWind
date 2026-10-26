/**
 * docs/specs/mandatory-ticket-fields.md R9 (PR 2.5), against a real database: the backfill
 * migration fills the four mandatory values on workflow records only, never overwrites one,
 * and leaves the check query at zero. Runs the migration's own SQL (found by name, so a
 * renumber doesn't break it) on a freshly generated tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  workflows,
  entityTypes,
  entityInstances,
} from "@platform/db";

const MIGRATIONS = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);
const BACKFILL_FILE = readdirSync(MIGRATIONS).find((f) =>
  f.endsWith("_backfill_mandatory_ticket_fields.sql"),
);
let BACKFILL_SQL = "";

const TENANT = randomUUID();
const REMARK =
  "Backfilled: no remark was recorded when this ticket was created.";
const CREATED = new Date("2026-01-10T09:00:00.000Z");

let ticketTypeId: string;
let plainTypeId: string;
let workflowId: string;
const ids: Record<string, string> = {};

async function insertRecord(
  key: string,
  values: Partial<typeof entityInstances.$inferInsert> & {
    entityTypeId: string;
  },
): Promise<void> {
  const [row] = await withTenantContext(TENANT, (tx) =>
    tx
      .insert(entityInstances)
      .values({
        tenantId: TENANT,
        currentState: "open",
        createdAt: CREATED,
        ...values,
      })
      .returning({ id: entityInstances.id }),
  );
  ids[key] = row!.id;
}

async function load(key: string): Promise<typeof entityInstances.$inferSelect> {
  const [row] = await withTenantContext(TENANT, (tx) =>
    tx.select().from(entityInstances).where(eq(entityInstances.id, ids[key]!)),
  );
  return row!;
}

beforeAll(async () => {
  if (!BACKFILL_FILE)
    throw new Error(
      "backfill migration file not found — check migrations directory",
    );
  BACKFILL_SQL = readFileSync(join(MIGRATIONS, BACKFILL_FILE), "utf8");
  await db.insert(tenants).values({
    id: TENANT,
    name: `backfill ${TENANT}`,
    slug: `backfill-${TENANT}`,
  });
  await withTenantContext(TENANT, async (tx) => {
    const [ticketType] = await tx
      .insert(entityTypes)
      .values({
        tenantId: TENANT,
        name: `bf_ticket_${Date.now()}`,
        plural: "bf_tickets",
      })
      .returning({ id: entityTypes.id });
    const [plainType] = await tx
      .insert(entityTypes)
      .values({
        tenantId: TENANT,
        name: `bf_plain_${Date.now()}`,
        plural: "bf_plains",
      })
      .returning({ id: entityTypes.id });
    ticketTypeId = ticketType!.id;
    plainTypeId = plainType!.id;
    const [wf] = await tx
      .insert(workflows)
      .values({
        tenantId: TENANT,
        entityTypeId: ticketTypeId,
        name: "BF Support",
        initialState: "open",
      })
      .returning({ id: workflows.id });
    workflowId = wf!.id;
  });

  // Missing everything, on the workflow.
  await insertRecord("bare", {
    entityTypeId: ticketTypeId,
    workflowId,
    fields: { title: "  " },
  });
  // No workflowId, but its type has an active workflow; only the remark is missing.
  await insertRecord("typed", {
    entityTypeId: ticketTypeId,
    fields: { title: "Printer offline" },
    dueDate: new Date("2026-02-01T09:00:00.000Z"),
    severity: "high",
  });
  // Complete: nothing may change.
  await insertRecord("complete", {
    entityTypeId: ticketTypeId,
    workflowId,
    fields: { title: "Kept" },
    dueDate: new Date("2026-03-01T09:00:00.000Z"),
    remark: "Original remark",
    severity: "low",
  });
  // Not a workflow record: left alone.
  await insertRecord("plain", { entityTypeId: plainTypeId, fields: {} });

  await db.execute(sql.raw(BACKFILL_SQL));
});

afterAll(async () => {
  for (const table of ["entity_instances", "workflows", "entity_types"]) {
    await db.execute(
      sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${TENANT}::uuid`,
    );
  }
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
});

describe("mandatory fields backfill (PR 2.5)", () => {
  it("fills every missing value on a workflow record with the agreed defaults", async () => {
    const row = await load("bare");
    expect((row.fields as Record<string, unknown>)["title"]).toBe(
      `Untitled ticket #${ids["bare"]!.slice(0, 8)}`,
    );
    expect(row.dueDate?.toISOString()).toBe("2026-01-17T09:00:00.000Z");
    expect(row.remark).toBe(REMARK);
    expect(row.severity).toBe("medium");
  });

  it("fills only what's missing, on a record whose type has a workflow", async () => {
    const row = await load("typed");
    expect((row.fields as Record<string, unknown>)["title"]).toBe(
      "Printer offline",
    );
    expect(row.dueDate?.toISOString()).toBe("2026-02-01T09:00:00.000Z");
    expect(row.severity).toBe("high");
    expect(row.remark).toBe(REMARK);
  });

  it("leaves a complete record and a non-workflow record untouched", async () => {
    const complete = await load("complete");
    expect(complete.remark).toBe("Original remark");
    expect(complete.severity).toBe("low");
    expect((complete.fields as Record<string, unknown>)["title"]).toBe("Kept");

    const plain = await load("plain");
    expect(plain.fields).toEqual({});
    expect(plain.remark).toBeNull();
    expect(plain.dueDate).toBeNull();
  });

  it("leaves the check query at zero, and changes nothing when run again", async () => {
    const check = await db.execute<{ missing: number }>(sql`
      SELECT count(*)::int AS missing FROM entity_instances ei
      WHERE ei.tenant_id = ${TENANT}::uuid
        AND (ei.workflow_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM workflows w WHERE w.entity_type_id = ei.entity_type_id
            AND w.is_active AND (w.tenant_id = ei.tenant_id OR w.tenant_id IS NULL)))
        AND (coalesce(btrim(ei.fields ->> 'title'), '') = '' OR ei.due_date IS NULL
             OR coalesce(btrim(ei.remark), '') = '' OR ei.severity IS NULL)
    `);
    expect(check[0]?.missing).toBe(0);

    const before = await load("bare");
    await db.execute(sql.raw(BACKFILL_SQL));
    const after = await load("bare");
    expect(after).toEqual(before);
  });
});
