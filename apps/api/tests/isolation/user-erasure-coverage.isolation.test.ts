/**
 * #635 / docs/specs/gdpr-erasure-coverage.md R3–R4: per-user erasure, run the
 * way DELETE /users/:userId runs it — as app_user, with the *admin* as
 * app.user_id — removes or scrubs every handled user-reference column, keeps
 * other users' data, and never touches another tenant.
 *
 * Calls the real eraseUserFromTenant (spec V3 — never a hand-copied subset of
 * its statements). Seeds with the same every-table fixture the tenant-purge
 * coverage test uses, plus rows where a *different* user's data references the
 * target.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  tenants,
  withTenantContext,
  withTenantAndUserContext,
  apiKeys,
  savedViews,
  ticketAlerts,
  onCallSchedules,
  attachments,
  entityInstances,
  entityTypes,
  teams,
  adminAuditLog,
} from "@platform/db";
import {
  eraseUserFromTenant,
  USER_REFERENCE_COLUMNS_HANDLED,
} from "../../src/services/user-erasure.js";

const TENANT = "aaaaaaaa-0635-4000-a000-0000000000e1";
const BYSTANDER = "bbbbbbbb-0635-4000-b000-0000000000e2";
const TARGET = "u-erasure-target";
const OTHER = "u-erasure-other";

const SEED = readFileSync(
  join(
    __dirname,
    "../../../worker/tests/isolation/fixtures/seed-every-tenant-table.sql",
  ),
  "utf8",
);

type ColumnRef = { table: string; column: string; udt: string };

async function handledColumns(): Promise<ColumnRef[]> {
  const rows = await db.execute<{
    table_name: string;
    column_name: string;
    udt_name: string;
  }>(sql`
    SELECT table_name, column_name, udt_name FROM information_schema.columns
    WHERE table_schema = 'public'`);
  const byKey = new Map(
    rows.map((r) => [`${r.table_name}.${r.column_name}`, r.udt_name]),
  );
  return USER_REFERENCE_COLUMNS_HANDLED.map((key) => {
    const [table = "", column = ""] = key.split(".");
    return { table, column, udt: byKey.get(key) ?? "missing" };
  });
}

// Rows in `tenantId` whose column still references `userId`, per column type.
async function referencesTo(
  tenantId: string,
  userId: string,
): Promise<string[]> {
  const leftovers: string[] = [];
  for (const { table, column, udt } of await handledColumns()) {
    // identifiers come from information_schema / a static list, not user input
    const col = sql.identifier(column);
    const match =
      udt === "_text"
        ? sql`${userId} = ANY(${col})`
        : udt === "jsonb"
          ? sql`${col} ? ${userId}`
          : sql`${col} = ${userId}`;
    const [row] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId} AND ${match}`,
    );
    if ((row?.n ?? 0) > 0) leftovers.push(`${table}.${column}=${row?.n}`);
  }
  return leftovers;
}

async function seedTenant(tenantId: string): Promise<void> {
  await db
    .insert(tenants)
    .values({
      id: tenantId,
      name: `#635 erasure ${tenantId}`,
      slug: `erasure-coverage-${tenantId}`,
    })
    .onConflictDoNothing();
  await db.execute(
    sql.raw(
      SEED.replaceAll("__TENANT__", tenantId).replaceAll("__USER__", TARGET),
    ),
  );
}

let otherAlertId: string;
let backupOnlyScheduleId: string;
let otherAttachmentId: string;
let grantedInstanceId: string;
let legacyGrantInstanceId: string;
let rotatedKeyId: string;
let bystanderBefore: string[];

beforeAll(async () => {
  await seedTenant(TENANT);
  await seedTenant(BYSTANDER);

  // Rows owned by OTHER that reference TARGET — must be scrubbed, not deleted.
  const [et] = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(eq(entityTypes.tenantId, TENANT));
  if (!et) throw new Error("seed: entity type missing");
  const [inst] = await db
    .insert(entityInstances)
    .values({
      tenantId: TENANT,
      entityTypeId: et.id,
      createdBy: OTHER,
      fields: {
        title: "shared",
        __accessUsers: {
          [TARGET]: { level: "read_only", tag: "mention" },
          [OTHER]: { level: "read_write", tag: "mention" },
        },
      },
    })
    .returning();
  if (!inst) throw new Error("seed: instance insert failed");
  grantedInstanceId = inst.id;

  // Legacy string[] shape of __accessUsers, still read by entity-access.ts
  const [legacy] = await db
    .insert(entityInstances)
    .values({
      tenantId: TENANT,
      entityTypeId: et.id,
      createdBy: OTHER,
      fields: { title: "legacy", __accessUsers: [OTHER, TARGET] },
    })
    .returning();
  if (!legacy) throw new Error("seed: legacy instance insert failed");
  legacyGrantInstanceId = legacy.id;

  // OTHER rotated TARGET's key: the new key points back via rotated_from.
  const [targetKey] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, TENANT), eq(apiKeys.createdBy, TARGET)));
  if (!targetKey) throw new Error("seed: target api key missing");
  const [rotated] = await db
    .insert(apiKeys)
    .values({
      tenantId: TENANT,
      name: "rotated",
      keyHash: `hash-rotated-${TENANT}`,
      createdBy: OTHER,
      rotatedFrom: targetKey.id,
    })
    .returning();
  if (!rotated) throw new Error("seed: rotated key insert failed");
  rotatedKeyId = rotated.id;

  const [alert] = await db
    .insert(ticketAlerts)
    .values({
      tenantId: TENANT,
      instanceId: inst.id,
      createdBy: OTHER,
      note: "team alert",
      fireAt: new Date(),
      scope: "all",
      recipientsSnapshot: [OTHER, TARGET],
    })
    .returning();
  if (!alert) throw new Error("seed: alert insert failed");
  otherAlertId = alert.id;

  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.tenantId, TENANT));
  if (!team) throw new Error("seed: team missing");
  const [sched] = await db
    .insert(onCallSchedules)
    .values({
      tenantId: TENANT,
      teamId: team.id,
      label: "other's week",
      // after the seeded week-long shift — on_call_schedules forbids overlap
      startsAt: new Date(Date.now() + 30 * 86_400_000),
      endsAt: new Date(Date.now() + 31 * 86_400_000),
      primaryUserId: OTHER,
      backupUserId: TARGET,
      createdBy: OTHER,
    })
    .returning();
  if (!sched) throw new Error("seed: schedule insert failed");
  backupOnlyScheduleId = sched.id;

  const [att] = await db
    .insert(attachments)
    .values({
      tenantId: TENANT,
      uploadedBy: OTHER,
      actingPersonId: TARGET,
      declaredFilename: "b.txt",
      declaredSizeBytes: 1,
      declaredMimeType: "text/plain",
      uploadTokenHash: `h2-${TENANT}`,
      uploadExpiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning();
  if (!att) throw new Error("seed: attachment insert failed");
  otherAttachmentId = att.id;

  await db.insert(savedViews).values({
    tenantId: TENANT,
    userId: OTHER,
    entityTypeId: et.id,
    name: "other's view",
  });

  bystanderBefore = await referencesTo(BYSTANDER, TARGET);

  // Same context the route runs in: withTenantContext, so app.user_id is
  // unset — the target's saved_views are invisible without the service's
  // GUC switch.
  await withTenantContext(TENANT, (tx) =>
    eraseUserFromTenant(tx, TENANT, TARGET),
  );
});

afterAll(async () => {
  for (const tenantId of [TENANT, BYSTANDER]) {
    const tables = await db.execute<{ table_name: string }>(sql`
      SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE'`);
    for (let pass = 0; pass < 6; pass++) {
      for (const { table_name } of tables) {
        await db
          .execute(
            sql`DELETE FROM ${sql.identifier(table_name)} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => undefined);
      }
    }
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
});

describe("per-user erasure — column coverage (#635)", () => {
  it("every handled column exists in the schema", async () => {
    const missing = (await handledColumns())
      .filter((c) => c.udt === "missing")
      .map((c) => `${c.table}.${c.column}`);
    expect(missing).toEqual([]);
  });

  it("leaves no handled column referencing the erased user", async () => {
    expect(await referencesTo(TENANT, TARGET)).toEqual([]);
  });

  it("removes the target's per-record access grant but keeps other users' grants", async () => {
    const [row] = await db
      .select({ fields: entityInstances.fields })
      .from(entityInstances)
      .where(eq(entityInstances.id, grantedInstanceId));
    // jsonb payload — shape seeded above
    const grants = (row?.fields as { __accessUsers?: Record<string, unknown> })
      .__accessUsers;
    expect(grants).toBeDefined();
    expect(Object.keys(grants ?? {})).toEqual([OTHER]);
  });

  it("handles the legacy string[] shape of __accessUsers", async () => {
    const [row] = await db
      .select({ fields: entityInstances.fields })
      .from(entityInstances)
      .where(eq(entityInstances.id, legacyGrantInstanceId));
    // jsonb payload — shape seeded above
    expect((row?.fields as { __accessUsers?: unknown }).__accessUsers).toEqual([
      OTHER,
    ]);
  });

  it("keeps the target's api keys anonymized, and another user's rotated key keeps its lineage (#688)", async () => {
    const [rotated] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, rotatedKeyId));
    expect(rotated?.createdBy).toBe(OTHER);
    expect(rotated?.rotatedFrom).not.toBeNull();
    const [original] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, rotated?.rotatedFrom ?? ""));
    expect(original?.createdBy).toBe("[REDACTED]");
  });

  it("deletes the target's saved views when app.user_id is unset (route context), and keeps others'", async () => {
    const rows = await db
      .select({ userId: savedViews.userId })
      .from(savedViews)
      .where(eq(savedViews.tenantId, TENANT));
    expect(rows.map((r) => r.userId)).toEqual([OTHER]);
  });

  it("scrubs the target from other users' rows instead of deleting them", async () => {
    const [alert] = await db
      .select({ recipients: ticketAlerts.recipientsSnapshot })
      .from(ticketAlerts)
      .where(eq(ticketAlerts.id, otherAlertId));
    expect(alert?.recipients).toEqual([OTHER]);

    const [sched] = await db
      .select()
      .from(onCallSchedules)
      .where(eq(onCallSchedules.id, backupOnlyScheduleId));
    expect(sched?.primaryUserId).toBe(OTHER);
    expect(sched?.backupUserId).toBeNull();

    const [att] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, otherAttachmentId));
    expect(att?.uploadedBy).toBe(OTHER);
    expect(att?.actingPersonId).toBe("[REDACTED]");
  });

  it("deletes on-call shifts where the erased user was primary", async () => {
    const rows = await db
      .select()
      .from(onCallSchedules)
      .where(
        and(
          eq(onCallSchedules.tenantId, TENANT),
          eq(onCallSchedules.primaryUserId, TARGET),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("keeps the audit log untouched (Art. 17(3)(b) exemption)", async () => {
    const rows = await db
      .select({ actorId: adminAuditLog.actorId })
      .from(adminAuditLog)
      .where(eq(adminAuditLog.tenantId, TENANT));
    expect(rows.map((r) => r.actorId)).toContain(TARGET);
  });

  it("restores the caller's app.user_id after switching it for the saved_views delete", async () => {
    // Re-running is a no-op on data (idempotent); this checks only the GUC.
    const after = await withTenantAndUserContext(
      TENANT,
      "u-erasure-admin",
      async (tx) => {
        await eraseUserFromTenant(tx, TENANT, TARGET);
        const [row] = await tx.execute<{ current: string | null }>(
          sql`SELECT current_setting('app.user_id', true) AS current`,
        );
        return row?.current;
      },
    );
    expect(after).toBe("u-erasure-admin");
  });

  it("does not touch another tenant's references to the same user id", async () => {
    expect(bystanderBefore.length).toBeGreaterThan(0);
    expect(await referencesTo(BYSTANDER, TARGET)).toEqual(bystanderBefore);
  });
});
