/**
 * ADR-012 Phase G, spec R8 -- access-log-retention.ts's real aggregate-then-
 * delete SQL (raw CTEs), exercised against a real Postgres database. The
 * sibling unit test (access-log-retention.test.ts) fully mocks db.execute
 * and only covers the batching/loop-termination logic -- this is the one
 * place the actual SQL, and the new admin_audit_log_daily_rollup table, are
 * proven against a live database (db-conventions.md: "isolation tests
 * travel with every new table").
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  tenants,
  adminAuditLog,
  adminAuditLogDailyRollup,
  setAccessLogRetentionRole,
} from "@platform/db";

// vitest 4.x: mockImplementation must use a regular function (not arrow) when
// the mock is used with `new` — arrow functions are not constructable.
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function () {
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
  Queue: vi.fn().mockImplementation(function () {
    return {
      add: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock("../../src/queues.js", () => ({ connection: {} }));

const { runAccessLogRetentionSweep } =
  await import("../../src/access-log-retention.js");

const TENANT_ID = "ffffffff-c000-4000-a000-00000000003a";
const RESOURCE_ID = "ffffffff-c000-4000-a000-00000000003b";
const OLD_DATE = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
const RECENT_DATE = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: "Access log retention isolation tenant",
      slug: `access-log-retention-${Date.now()}`,
    })
    .onConflictDoNothing();

  // Three rows older than 90 days, same (tenant, day, resourceType, action)
  // -- should collapse into one rollup row with count=3 and be deleted.
  await db.insert(adminAuditLog).values([
    {
      tenantId: TENANT_ID,
      actorId: "user-a",
      actorType: "user",
      resourceType: "ticket",
      resourceId: RESOURCE_ID,
      action: "created",
      createdAt: OLD_DATE,
    },
    {
      tenantId: TENANT_ID,
      actorId: "user-b",
      actorType: "user",
      resourceType: "ticket",
      resourceId: RESOURCE_ID,
      action: "created",
      createdAt: OLD_DATE,
    },
    {
      tenantId: TENANT_ID,
      actorId: "user-c",
      actorType: "user",
      resourceType: "ticket",
      resourceId: RESOURCE_ID,
      action: "created",
      createdAt: OLD_DATE,
    },
    // A recent row -- must survive the sweep untouched.
    {
      tenantId: TENANT_ID,
      actorId: "user-d",
      actorType: "user",
      resourceType: "ticket",
      resourceId: RESOURCE_ID,
      action: "created",
      createdAt: RECENT_DATE,
    },
  ]);
});

afterAll(async () => {
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_ID));
  await db
    .delete(adminAuditLogDailyRollup)
    .where(eq(adminAuditLogDailyRollup.tenantId, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

describe("access-log-retention: real sweep against Postgres (ADR-012 Phase G, spec R8)", () => {
  it("deletes rows older than 90 days and rolls their count up, leaving recent rows untouched", async () => {
    await runAccessLogRetentionSweep();

    const remaining = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.tenantId, TENANT_ID));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.actorId).toBe("user-d");

    const rollupRows = await db
      .select()
      .from(adminAuditLogDailyRollup)
      .where(
        and(
          eq(adminAuditLogDailyRollup.tenantId, TENANT_ID),
          eq(adminAuditLogDailyRollup.resourceType, "ticket"),
          eq(adminAuditLogDailyRollup.action, "created"),
        ),
      );
    expect(rollupRows).toHaveLength(1);
    expect(rollupRows[0]?.count).toBe(3);
  });

  it("running the sweep again with nothing new to sweep does not double-count the rollup", async () => {
    await runAccessLogRetentionSweep();

    const rollupRows = await db
      .select()
      .from(adminAuditLogDailyRollup)
      .where(
        and(
          eq(adminAuditLogDailyRollup.tenantId, TENANT_ID),
          eq(adminAuditLogDailyRollup.resourceType, "ticket"),
          eq(adminAuditLogDailyRollup.action, "created"),
        ),
      );
    expect(rollupRows).toHaveLength(1);
    expect(rollupRows[0]?.count).toBe(3);
  });
});

describe("access-log-retention: rollup upsert conflict path (#1131)", () => {
  it("adds to an existing rollup row via ON CONFLICT DO UPDATE under the narrow role's grants", async () => {
    await db.insert(adminAuditLog).values({
      tenantId: TENANT_ID,
      actorId: "user-f",
      actorType: "user",
      resourceType: "ticket",
      resourceId: RESOURCE_ID,
      action: "created",
      createdAt: OLD_DATE,
    });

    await runAccessLogRetentionSweep();

    const [row] = await db
      .select()
      .from(adminAuditLogDailyRollup)
      .where(
        and(
          eq(adminAuditLogDailyRollup.tenantId, TENANT_ID),
          eq(adminAuditLogDailyRollup.action, "created"),
        ),
      );
    expect(row?.count).toBe(4);
  });
});

// This suite connects as a superuser, but SET LOCAL ROLE drops superuser rights, so grants and RLS
// are genuinely enforced for the role under test (#1131; migration 0158).
const AS_APP_USER = sql`SET LOCAL ROLE app_user`;

describe("access_log_retention_role (migration 0158, #1131)", () => {
  async function expectDenied(
    setup: ReturnType<typeof sql>,
    statement: ReturnType<typeof sql>,
  ): Promise<void> {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(setup);
        await tx.execute(statement);
      }),
    ).rejects.toThrow();
  }

  const asRetention = sql`SET LOCAL ROLE access_log_retention_role`;
  const DELETE_AUDIT = sql`DELETE FROM admin_audit_log WHERE tenant_id = ${TENANT_ID}`;

  it("app_user cannot DELETE a row the narrow role can", async () => {
    const marker = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    await db.insert(adminAuditLog).values({
      tenantId: TENANT_ID,
      actorId: "user-e",
      actorType: "user",
      resourceType: "ticket",
      resourceId: RESOURCE_ID,
      action: "updated",
      createdAt: marker,
    });

    await expectDenied(AS_APP_USER, DELETE_AUDIT);

    const deleted = await db.transaction(async (tx) => {
      await setAccessLogRetentionRole(tx);
      return tx.execute<{ n: number }>(
        sql`WITH d AS (DELETE FROM admin_audit_log WHERE tenant_id = ${TENANT_ID}
            AND action = 'updated' RETURNING 1) SELECT count(*)::int AS n FROM d`,
      );
    });
    expect(deleted[0]?.n).toBe(1);
  });

  it("the narrow role cannot see or delete rows inside the retention window", async () => {
    const counts = await db.transaction(async (tx) => {
      await setAccessLogRetentionRole(tx);
      const seen = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM admin_audit_log
            WHERE tenant_id = ${TENANT_ID} AND created_at > now() - interval '30 days'`,
      );
      const del = await tx.execute<{ n: number }>(
        sql`WITH d AS (DELETE FROM admin_audit_log WHERE tenant_id = ${TENANT_ID}
            AND created_at > now() - interval '30 days' RETURNING 1)
            SELECT count(*)::int AS n FROM d`,
      );
      return { seen: seen[0]?.n, deleted: del[0]?.n };
    });
    expect(counts).toEqual({ seen: 0, deleted: 0 });
    const [recent] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM admin_audit_log WHERE tenant_id = ${TENANT_ID}`,
    );
    expect(recent?.n).toBe(1);
  });

  it("app_user still has no UPDATE on admin_audit_log", async () => {
    await expectDenied(
      AS_APP_USER,
      sql`UPDATE admin_audit_log SET action = 'x' WHERE tenant_id = ${TENANT_ID}`,
    );
  });

  it("the narrow role cannot UPDATE or INSERT admin_audit_log, or read PII columns", async () => {
    await expectDenied(
      asRetention,
      sql`UPDATE admin_audit_log SET action = 'x' WHERE tenant_id = ${TENANT_ID}`,
    );
    await expectDenied(
      asRetention,
      sql`INSERT INTO admin_audit_log (tenant_id, actor_id, actor_type, resource_type, resource_id, action)
          VALUES (${TENANT_ID}, 'x', 'user', 'ticket', ${RESOURCE_ID}, 'created')`,
    );
    await expectDenied(
      asRetention,
      sql`SELECT actor_id FROM admin_audit_log LIMIT 1`,
    );
  });

  it("the narrow role cannot DELETE rollups, change rollup keys, or touch other tables", async () => {
    await expectDenied(
      asRetention,
      sql`DELETE FROM admin_audit_log_daily_rollup WHERE tenant_id = ${TENANT_ID}`,
    );
    await expectDenied(
      asRetention,
      sql`UPDATE admin_audit_log_daily_rollup SET action = 'x' WHERE tenant_id = ${TENANT_ID}`,
    );
    await expectDenied(asRetention, sql`SELECT 1 FROM tenants LIMIT 1`);
    await expectDenied(
      asRetention,
      sql`DELETE FROM tenants WHERE id = ${TENANT_ID}`,
    );
  });

  it("is NOLOGIN and NOT BYPASSRLS, and app_user holds it without inheriting", async () => {
    const [role] = await db.execute<{
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      sql`SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'access_log_retention_role'`,
    );
    expect(role).toEqual({
      rolcanlogin: false,
      rolbypassrls: false,
      rolsuper: false,
    });
    const [m] = await db.execute<{ inherit_option: boolean }>(
      sql`SELECT inherit_option FROM pg_auth_members
          WHERE roleid = 'access_log_retention_role'::regrole
            AND member = 'app_user'::regrole`,
    );
    expect(m?.inherit_option).toBe(false);
  });
});
