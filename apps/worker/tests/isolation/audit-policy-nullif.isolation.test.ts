/**
 * #1188 -- the tenant isolation policies on admin_audit_log and
 * admin_audit_log_daily_rollup must tolerate app.tenant_id reading '' (not NULL).
 *
 * After any transaction-local set_config, a pooled connection reads the setting
 * back as '' for the rest of its life. A policy that casts it to uuid without
 * NULLIF then throws `invalid input syntax for type uuid: ""` whenever it is
 * evaluated, which includes every role-switched sweep (access_log_retention_role,
 * tenant_purge_role) on a row that role's own policy rejects. The pool here is
 * deliberately saturated with tenant transactions first, so every connection is
 * in that state.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray, sql } from "drizzle-orm";
import {
  db,
  tenants,
  adminAuditLog,
  adminAuditLogDailyRollup,
  withTenantContext,
} from "@platform/db";

// The sweep module builds a BullMQ worker at import time; the sibling
// access-log-retention.isolation.test.ts mocks it the same way.
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

const TENANT_A = "ffffffff-c000-4000-a000-00000000005a";
const TENANT_B = "ffffffff-c000-4000-a000-00000000005b";
const RESOURCE_ID = "ffffffff-c000-4000-a000-00000000005c";
const OLD_DATE = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);
const RECENT_DATE = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

/** Run enough concurrent tenant transactions that every pooled connection has set app.tenant_id. */
async function poisonPool(): Promise<void> {
  await Promise.all(
    Array.from({ length: 12 }, () =>
      withTenantContext(TENANT_A, async (tx) => {
        await tx.execute(sql`SELECT pg_sleep(0.05)`);
      }),
    ),
  );
}

async function currentTenantSettings(): Promise<(string | null)[]> {
  const reads = await Promise.all(
    Array.from({ length: 6 }, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_sleep(0.05)`);
        const [row] = await tx.execute<{ v: string | null }>(
          sql`SELECT current_setting('app.tenant_id', true) AS v`,
        );
        return row?.v ?? null;
      }),
    ),
  );
  return reads;
}

beforeAll(async () => {
  await db
    .insert(tenants)
    .values([
      { id: TENANT_A, name: "nullif A", slug: `nullif-a-${Date.now()}` },
      { id: TENANT_B, name: "nullif B", slug: `nullif-b-${Date.now()}` },
    ])
    .onConflictDoNothing();

  await db.insert(adminAuditLog).values(
    [TENANT_A, TENANT_B].flatMap((tenantId) => [
      {
        tenantId,
        actorId: "old",
        actorType: "user",
        resourceType: "ticket",
        resourceId: RESOURCE_ID,
        action: "created",
        createdAt: OLD_DATE,
      },
      {
        tenantId,
        actorId: "recent",
        actorType: "user",
        resourceType: "ticket",
        resourceId: RESOURCE_ID,
        action: "created",
        createdAt: RECENT_DATE,
      },
    ]),
  );

  await db.insert(adminAuditLogDailyRollup).values(
    [TENANT_A, TENANT_B].map((tenantId) => ({
      tenantId,
      day: "2020-01-01",
      resourceType: "seed",
      action: "seed",
      count: 1,
    })),
  );

  await poisonPool();
});

afterAll(async () => {
  for (const table of [adminAuditLogDailyRollup, adminAuditLog]) {
    await db.delete(table).where(inArray(table.tenantId, [TENANT_A, TENANT_B]));
  }
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("tenant policies tolerate app.tenant_id reading '' (#1188)", () => {
  it("precondition: every pooled connection now reads the setting back as ''", async () => {
    const reads = await currentTenantSettings();
    expect(reads.every((v) => v === "")).toBe(true);
  });

  it("the real access-log sweep runs on a poisoned pool and rolls up both tenants", async () => {
    await expect(runAccessLogRetentionSweep()).resolves.toBeUndefined();

    const rollup = await db
      .select()
      .from(adminAuditLogDailyRollup)
      .where(inArray(adminAuditLogDailyRollup.tenantId, [TENANT_A, TENANT_B]));
    const rolledUp = rollup.filter((r) => r.action === "created");
    expect(rolledUp.map((r) => [r.tenantId, r.count]).sort()).toEqual([
      [TENANT_A, 1],
      [TENANT_B, 1],
    ]);

    const remaining = await db
      .select({ actorId: adminAuditLog.actorId })
      .from(adminAuditLog)
      .where(inArray(adminAuditLog.tenantId, [TENANT_A, TENANT_B]));
    expect(remaining.map((r) => r.actorId)).toEqual(["recent", "recent"]);
  });

  it("a session whose tenant reads '' sees no rows and does not throw", async () => {
    const counts = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      const [audit] = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM admin_audit_log
            WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`,
      );
      const [rollup] = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM admin_audit_log_daily_rollup
            WHERE tenant_id IN (${TENANT_A}, ${TENANT_B})`,
      );
      return { audit: audit?.n, rollup: rollup?.n };
    });
    expect(counts).toEqual({ audit: 0, rollup: 0 });
  });

  it("a tenant session still sees only its own rows", async () => {
    const seen = await withTenantContext(TENANT_A, async (tx) => {
      const audit = await tx
        .select({ tenantId: adminAuditLog.tenantId })
        .from(adminAuditLog)
        .where(inArray(adminAuditLog.tenantId, [TENANT_A, TENANT_B]));
      const rollup = await tx
        .select({ tenantId: adminAuditLogDailyRollup.tenantId })
        .from(adminAuditLogDailyRollup)
        .where(
          inArray(adminAuditLogDailyRollup.tenantId, [TENANT_A, TENANT_B]),
        );
      return { audit, rollup };
    });
    expect(new Set(seen.audit.map((r) => r.tenantId))).toEqual(
      new Set([TENANT_A]),
    );
    expect(new Set(seen.rollup.map((r) => r.tenantId))).toEqual(
      new Set([TENANT_A]),
    );
  });

  it("both tenant policies read the tenant through NULLIF, including the rollup's WITH CHECK", async () => {
    // app_user has no INSERT grant on the rollup table, so a cross-tenant write is rejected by the
    // grant before any policy runs; the WITH CHECK clause has to be asserted on the definition.
    const policies = await db.execute<{
      polname: string;
      using_expr: string | null;
      check_expr: string | null;
    }>(sql`
      SELECT polname,
             pg_get_expr(polqual, polrelid) AS using_expr,
             pg_get_expr(polwithcheck, polrelid) AS check_expr
      FROM pg_policy
      WHERE polname IN ('audit_log_tenant_isolation',
                        'admin_audit_log_daily_rollup_tenant_isolation')
      ORDER BY polname`);
    expect(policies.map((p) => p.polname)).toEqual([
      "admin_audit_log_daily_rollup_tenant_isolation",
      "audit_log_tenant_isolation",
    ]);
    for (const p of policies) {
      expect(p.using_expr).toMatch(/nullif\(current_setting/i);
    }
    const [rollup, audit] = policies;
    expect(rollup?.check_expr).toMatch(/nullif\(current_setting/i);
    // FOR ALL with no WITH CHECK: Postgres applies USING to writes, so the audit policy keeps no separate clause.
    expect(audit?.check_expr).toBeNull();
  });
});
