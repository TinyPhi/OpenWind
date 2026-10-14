/**
 * Migration 0144: tenant_purge_role. tenant-purge's privileged pre-steps used to run on plain
 * `db`, assumed privileged; under the compose app_user connection the schedule_executions
 * delete was refused and, with no tenant context, RLS made the saved_views delete and the
 * audit-log anonymization match nothing. They now run in withTenantPurgeContext.
 *
 * This suite connects as a superuser, but withTenantPurgeContext does SET LOCAL ROLE, which
 * drops superuser rights -- so grants and RLS are genuinely enforced, exactly as for app_user.
 * It pins: an app_user session can switch into the role; the pre-steps clear tenant A and leave
 * tenant B untouched; the role can't touch audit columns outside the anonymized ones; and plain
 * app_user still can't make these writes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  tenants,
  adminAuditLog,
  savedViews,
  scheduleExecutions,
  scheduleRules,
  withTenantPurgeContext,
} from "@platform/db";
import { anonymizeAuditLogForTenant } from "@platform/audit";

const PURGED = "aaaaaaaa-0144-4000-a000-000000000144";
const BYSTANDER = "bbbbbbbb-0144-4000-b000-000000000144";
const USER = "u-purge-role";

const SEED = readFileSync(
  join(__dirname, "fixtures", "seed-every-tenant-table.sql"),
  "utf8",
);

async function seed(tenantId: string): Promise<void> {
  await db
    .insert(tenants)
    .values({
      id: tenantId,
      name: `purge-role ${tenantId}`,
      slug: `purge-role-${tenantId}`,
      status: "deleted",
    })
    .onConflictDoNothing();
  await db.execute(
    sql.raw(
      SEED.replaceAll("__TENANT__", tenantId).replaceAll("__USER__", USER),
    ),
  );
}

async function tenantTables(): Promise<string[]> {
  const rows = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
      AND table_name IN (
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      )
  `);
  return rows.map((r) => r.table_name);
}

async function count(
  table: "schedule_executions" | "saved_views",
  tenantId: string,
): Promise<number> {
  const [row] = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`,
  );
  return row?.n ?? 0;
}

async function auditActors(tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ actorId: adminAuditLog.actorId })
    .from(adminAuditLog)
    .where(
      and(
        eq(adminAuditLog.tenantId, tenantId),
        eq(adminAuditLog.actorType, "user"),
      ),
    );
  return rows.map((r) => r.actorId);
}

async function rejection(work: () => Promise<unknown>): Promise<string> {
  const err: unknown = await work().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "expected the write to be refused").toBeInstanceOf(Error);
  // Drizzle wraps the Postgres error; the permission message is on `cause`.
  return String((err as Error).cause ?? err);
}

beforeAll(async () => {
  await seed(PURGED);
  await seed(BYSTANDER);
});

afterAll(async () => {
  for (const tenantId of [PURGED, BYSTANDER]) {
    for (let pass = 0; pass < 6; pass++) {
      for (const table of await tenantTables()) {
        await db
          .execute(
            sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => undefined);
      }
    }
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
});

describe("tenant_purge_role (migration 0144)", () => {
  it("a real app_user session can switch into tenant_purge_role", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL SESSION AUTHORIZATION app_user`);
      await tx.execute(sql`SET LOCAL ROLE tenant_purge_role`);
      return tx.execute<{ session_user: string; current_user: string }>(
        sql`SELECT session_user, current_user`,
      );
    });

    expect(rows[0]).toEqual({
      session_user: "app_user",
      current_user: "tenant_purge_role",
    });
  });

  it("plain app_user still cannot delete schedule_executions or update admin_audit_log", async () => {
    const deleteMsg = await rejection(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${PURGED}, true)`,
        );
        await tx
          .delete(scheduleExecutions)
          .where(eq(scheduleExecutions.tenantId, PURGED));
      }),
    );
    expect(deleteMsg).toMatch(/permission denied/);

    const updateMsg = await rejection(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${PURGED}, true)`,
        );
        await tx
          .update(adminAuditLog)
          .set({ actorId: "x" })
          .where(eq(adminAuditLog.tenantId, PURGED));
      }),
    );
    expect(updateMsg).toMatch(/permission denied/);
  });

  it("cannot rewrite audit columns outside the person-identifying ones", async () => {
    const msg = await rejection(() =>
      withTenantPurgeContext(PURGED, (tx) =>
        tx
          .update(adminAuditLog)
          .set({ action: "deleted" })
          .where(eq(adminAuditLog.tenantId, PURGED)),
      ),
    );
    expect(msg).toMatch(/permission denied/);
  });

  it("gives a plain app_user session nothing from the purge policies (membership is INHERIT FALSE)", async () => {
    // app_user may DELETE saved_views, but only its own (user_id = app.user_id). Without
    // SET ROLE tenant_purge_role, the purge-only policies must not widen that.
    const before = await count("saved_views", PURGED);
    expect(before).toBeGreaterThan(0);

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL SESSION AUTHORIZATION app_user`);
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${PURGED}, true)`,
      );
      await tx.delete(savedViews).where(eq(savedViews.tenantId, PURGED));
    });

    expect(await count("saved_views", PURGED)).toBe(before);
  });

  it("only reaches the tenant in its context, even without a tenant_id filter", async () => {
    // RLS is the second layer behind the code's explicit filters: an unfiltered delete in
    // PURGED's context must still leave BYSTANDER's rows alone.
    const bystanderBefore = await count("schedule_executions", BYSTANDER);
    await withTenantPurgeContext(PURGED, (tx) =>
      tx.execute(sql`DELETE FROM schedule_executions`),
    );
    expect(await count("schedule_executions", PURGED)).toBe(0);
    expect(await count("schedule_executions", BYSTANDER)).toBe(bystanderBefore);
  });

  it("runs the purge pre-steps for one tenant and leaves the other untouched", async () => {
    expect(await count("saved_views", PURGED)).toBeGreaterThan(0);
    expect(await auditActors(PURGED)).toContain(USER);
    const bystanderViews = await count("saved_views", BYSTANDER);
    const bystanderExecutions = await count("schedule_executions", BYSTANDER);

    // The same statements tenant-purge.ts runs before its main transaction.
    await withTenantPurgeContext(PURGED, async (tx) => {
      await tx
        .update(scheduleRules)
        .set({ status: "archived" })
        .where(eq(scheduleRules.tenantId, PURGED));
      await tx
        .delete(scheduleExecutions)
        .where(eq(scheduleExecutions.tenantId, PURGED));
      await tx.delete(savedViews).where(eq(savedViews.tenantId, PURGED));
    });
    await withTenantPurgeContext(PURGED, (tx) =>
      anonymizeAuditLogForTenant(tx, PURGED),
    );

    expect(await count("schedule_executions", PURGED)).toBe(0);
    expect(await count("saved_views", PURGED)).toBe(0);
    const [rule] = await db
      .select({ status: scheduleRules.status })
      .from(scheduleRules)
      .where(eq(scheduleRules.tenantId, PURGED));
    expect(rule?.status).toBe("archived");
    expect(await auditActors(PURGED)).toEqual(
      expect.not.arrayContaining([USER]),
    );
    expect((await auditActors(PURGED)).length).toBeGreaterThan(0);

    expect(await count("saved_views", BYSTANDER)).toBe(bystanderViews);
    expect(await count("schedule_executions", BYSTANDER)).toBe(
      bystanderExecutions,
    );
    expect(await auditActors(BYSTANDER)).toContain(USER);
  });

  it("refuses to anonymize under another tenant's context", async () => {
    await expect(
      withTenantPurgeContext(BYSTANDER, (tx) =>
        anonymizeAuditLogForTenant(tx, PURGED),
      ),
    ).rejects.toThrow(/another tenant's RLS context/);
    expect(await auditActors(BYSTANDER)).toContain(USER);
  });
});
