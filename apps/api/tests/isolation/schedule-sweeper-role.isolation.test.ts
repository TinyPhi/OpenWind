/**
 * Reproduces and verifies the fix for a real bug found during manual QA of
 * the temporal scheduler (3F): schedule_rules has RLS requiring
 * app.tenant_id (0101_schedule_rules_table.sql's strict `tenant_id = ...`
 * policy, with no NULL-permissive fallback like outbox_events' widened
 * policy — see outbox-sweeper-role.isolation.test.ts's comment). The
 * worker's cross-tenant poll (schedulerTick/claimRule) can't set a single
 * tenant's app.tenant_id — there is no one tenant to scope a cross-tenant
 * poll to — so under plain app_user with no context, the poll always
 * matched zero rows, and no schedule rule ever fired.
 *
 * Fix (0107_schedule_sweeper_role.sql): a dedicated BYPASSRLS role,
 * table-scoped to schedule_rules only (SELECT/UPDATE), mirroring
 * outbox_sweeper.
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, inArray } from "drizzle-orm";
import { db, scheduleRules, entityTypes, tenants } from "@platform/db";

const TENANT_A = "aaaaaaaa-0107-4000-a000-000000000107";
const TENANT_B = "bbbbbbbb-0107-4000-b000-000000000107";

let entityTypeId: string;
let ruleAId: string;
let ruleBId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Schedule Sweeper Isolation Test A",
      slug: `schedule-sweeper-isolation-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Schedule Sweeper Isolation Test B",
      slug: `schedule-sweeper-isolation-b-${TENANT_B}`,
    },
  ]);

  const [entityType] = await db
    .insert(entityTypes)
    .values({ name: `schedule-sweeper-test-${TENANT_A}`, plural: "Tickets" })
    .returning({ id: entityTypes.id });
  entityTypeId = entityType!.id;

  const [ruleA] = await db
    .insert(scheduleRules)
    .values({
      tenantId: TENANT_A,
      name: "Sweeper Test A",
      cronExpr: "0 9 1 * *",
      entityTypeId,
      template: { title: "Sweeper Test" },
      createdBy: "sweeper-test-user-a",
    })
    .returning({ id: scheduleRules.id });
  const [ruleB] = await db
    .insert(scheduleRules)
    .values({
      tenantId: TENANT_B,
      name: "Sweeper Test B",
      cronExpr: "0 9 1 * *",
      entityTypeId,
      template: { title: "Sweeper Test" },
      createdBy: "sweeper-test-user-b",
    })
    .returning({ id: scheduleRules.id });
  ruleAId = ruleA!.id;
  ruleBId = ruleB!.id;
});

afterAll(async () => {
  await db
    .delete(scheduleRules)
    .where(inArray(scheduleRules.id, [ruleAId, ruleBId]));
  await db.delete(entityTypes).where(sql`id = ${entityTypeId}`);
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("schedule_rules cross-tenant sweep", () => {
  it("sees zero rows under plain app_user with no tenant context set (the bug this fixes)", async () => {
    // Regression guard for the actual production bug: schedule_rules' RLS
    // policy has no NULL-permissive fallback, so this scenario silently
    // matched nothing and no schedule rule ever fired -- if this assertion
    // ever fails (starts returning rows), something has changed the RLS
    // policy underneath schedule_sweeper's reason for existing.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      return tx
        .select({ id: scheduleRules.id, tenantId: scheduleRules.tenantId })
        .from(scheduleRules)
        .where(inArray(scheduleRules.id, [ruleAId, ruleBId]));
    });
    expect(rows).toHaveLength(0);
  });

  // The live cross-role SELECT itself is exercised end-to-end by
  // schedulerTick/claimRule against a real Postgres instance (this is
  // exactly what those two functions do); the catalog-level checks below
  // are the stable, deterministic way to assert this role's shape in an
  // isolation-test context without depending on driver/pooler-specific
  // mid-transaction role-switch behavior.
  it("schedule_sweeper role exists with BYPASSRLS and no other elevated attributes", async () => {
    const [role] = await db.execute<{
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcanlogin: boolean;
    }>(
      sql`SELECT rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = 'schedule_sweeper'`,
    );
    expect(role).toBeDefined();
    expect(role?.rolbypassrls).toBe(true);
    expect(role?.rolsuper).toBe(false);
    expect(role?.rolcanlogin).toBe(false);
  });

  it("schedule_sweeper is granted exactly SELECT and UPDATE on schedule_rules -- no INSERT/DELETE", async () => {
    // has_table_privilege (not information_schema.role_table_grants, whose
    // visibility rules excluded this grant under the connecting role used
    // here) is the reliable, role-agnostic way to check this.
    const [priv] = await db.execute<{
      can_select: boolean;
      can_update: boolean;
      can_insert: boolean;
      can_delete: boolean;
    }>(
      sql`SELECT
            has_table_privilege('schedule_sweeper', 'schedule_rules', 'SELECT') AS can_select,
            has_table_privilege('schedule_sweeper', 'schedule_rules', 'UPDATE') AS can_update,
            has_table_privilege('schedule_sweeper', 'schedule_rules', 'INSERT') AS can_insert,
            has_table_privilege('schedule_sweeper', 'schedule_rules', 'DELETE') AS can_delete`,
    );
    expect(priv?.can_select).toBe(true);
    expect(priv?.can_update).toBe(true);
    expect(priv?.can_insert).toBe(false);
    expect(priv?.can_delete).toBe(false);
  });

  it("app_user is a member of schedule_sweeper (can SET LOCAL ROLE into it)", async () => {
    const [membership] = await db.execute<{ is_member: boolean }>(
      sql`SELECT pg_has_role('app_user', 'schedule_sweeper', 'member') AS is_member`,
    );
    expect(membership?.is_member).toBe(true);
  });
});
