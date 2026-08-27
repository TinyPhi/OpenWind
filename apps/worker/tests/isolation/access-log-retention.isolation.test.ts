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
import { eq, and } from "drizzle-orm";
import {
  db,
  tenants,
  adminAuditLog,
  adminAuditLogDailyRollup,
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
