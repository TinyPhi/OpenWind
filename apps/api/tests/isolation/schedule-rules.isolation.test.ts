/**
 * Tenant isolation tests for schedule_rules and schedule_executions.
 *
 * docs/specs/temporal-scheduler.md T1, T2, R10 -- 3F temporal scheduler, Phase 1.
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  db,
  withTenantContext,
  scheduleRules,
  scheduleExecutions,
  entityTypes,
  workflows,
  tenants,
} from "@platform/db";

const TENANT_A = "aaaaaaaa-9999-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-9999-4000-b000-000000000002";
const USER_A = "aaaaaaaa-9999-4000-a000-000000000900";
const USER_B = "bbbbbbbb-9999-4000-b000-000000000900";

let entityTypeId: string;
let ruleAId: string;
let ruleBId: string;
let executionAId: string;
let executionBId: string;
let workflowBId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Schedule Rules Isolation Test A",
      slug: `schedule-rules-isolation-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Schedule Rules Isolation Test B",
      slug: `schedule-rules-isolation-b-${TENANT_B}`,
    },
  ]);

  const [entityType] = await db
    .insert(entityTypes)
    .values({ name: `schedule-rules-test-${TENANT_A}`, plural: "Tickets" })
    .returning({ id: entityTypes.id });
  entityTypeId = entityType!.id;

  // A real workflow owned by Tenant B -- used to prove Tenant A's rule can
  // reference it via a plain FK (existence-only) despite belonging to a
  // different tenant; see the cross-tenant WRITE isolation describe block.
  const [workflowB] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT_B,
      entityTypeId,
      name: `Tenant B workflow ${TENANT_B}`,
      initialState: "open",
    })
    .returning({ id: workflows.id });
  workflowBId = workflowB!.id;

  const [ruleA] = await db
    .insert(scheduleRules)
    .values({
      tenantId: TENANT_A,
      name: "Monthly Review A",
      cronExpr: "0 9 1 * *",
      entityTypeId,
      template: { title: "Monthly Review" },
      createdBy: USER_A,
    })
    .returning({ id: scheduleRules.id });
  const [ruleB] = await db
    .insert(scheduleRules)
    .values({
      tenantId: TENANT_B,
      name: "Monthly Review B",
      cronExpr: "0 9 1 * *",
      entityTypeId,
      template: { title: "Monthly Review" },
      createdBy: USER_B,
    })
    .returning({ id: scheduleRules.id });
  ruleAId = ruleA!.id;
  ruleBId = ruleB!.id;

  const [executionA] = await db
    .insert(scheduleExecutions)
    .values({
      tenantId: TENANT_A,
      ruleId: ruleAId,
      scheduledAt: new Date("2026-10-01T09:00:00Z"),
      status: "success",
    })
    .returning({ id: scheduleExecutions.id });
  const [executionB] = await db
    .insert(scheduleExecutions)
    .values({
      tenantId: TENANT_B,
      ruleId: ruleBId,
      scheduledAt: new Date("2026-10-01T09:00:00Z"),
      status: "success",
    })
    .returning({ id: scheduleExecutions.id });
  executionAId = executionA!.id;
  executionBId = executionB!.id;
});

afterAll(async () => {
  await db
    .delete(scheduleExecutions)
    .where(inArray(scheduleExecutions.id, [executionAId, executionBId]));
  await db
    .delete(scheduleRules)
    .where(inArray(scheduleRules.id, [ruleAId, ruleBId]));
  await db.delete(workflows).where(eq(workflows.id, workflowBId));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("schedule_rules — cross-tenant READ isolation", () => {
  it("Tenant A's read scoped to Tenant A does not return Tenant B's rule", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: scheduleRules.id })
        .from(scheduleRules)
        .where(
          and(
            eq(scheduleRules.id, ruleBId),
            eq(scheduleRules.tenantId, TENANT_A),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A can read its own rule", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: scheduleRules.id })
        .from(scheduleRules)
        .where(eq(scheduleRules.tenantId, TENANT_A));
      expect(rows.map((r) => r.id)).toContain(ruleAId);
    });
  });

  it("RLS blocks a raw cross-tenant SELECT under app_user role", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
      );
      return tx
        .select({ id: scheduleRules.id })
        .from(scheduleRules)
        .where(eq(scheduleRules.id, ruleBId));
    });
    expect(rows).toHaveLength(0);
  });
});

describe("schedule_rules — cross-tenant WRITE isolation", () => {
  it("RLS blocks inserting a row tagged with a different tenant_id under app_user role", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx.insert(scheduleRules).values({
          tenantId: TENANT_B,
          name: "Smuggled Rule",
          cronExpr: "0 9 1 * *",
          entityTypeId,
          template: { title: "Smuggled" },
          createdBy: USER_A,
        });
      }),
    ).rejects.toBeTruthy();
  });

  // Documents a known architectural risk boundary (same pattern established
  // by PR #585's B1 and PR #586's B3): workflow_id has no FK-level tenant
  // guard beyond existence (migration 0101's comment), and template's
  // team_id/service_id/assignee_id live inside the JSONB column, which
  // can't carry a FK at all. RLS on this table only checks tenant_id, so a
  // rule tagged with the caller's own tenant_id but referencing another
  // tenant's workflow_id/template refs passes RLS. The route layer's
  // validateScheduleRuleRefs (packages/scheduler) is the only guard.
  it("RLS alone does NOT catch a cross-tenant workflow_id or template team_id smuggled under the correct tenant_id -- app-layer validation is the only guard", async () => {
    // workflowBId is a REAL row (belongs to Tenant B) -- the FK on
    // workflow_id is satisfied, so only tenant-ownership is being tested
    // here, not mere existence.
    const foreignTeamId = "77777777-7777-4777-8777-777777777799";
    let smuggledId: string | undefined;
    await withTenantContext(TENANT_A, async (tx) => {
      const [row] = await tx
        .insert(scheduleRules)
        .values({
          tenantId: TENANT_A,
          name: `Smuggled Refs ${TENANT_A}`,
          cronExpr: "0 9 1 * *",
          entityTypeId,
          workflowId: workflowBId,
          template: { title: "Smuggled", team_id: foreignTeamId },
          createdBy: USER_A,
        })
        .returning({
          id: scheduleRules.id,
          workflowId: scheduleRules.workflowId,
        });
      expect(row?.workflowId).toBe(workflowBId);
      smuggledId = row?.id;
    });

    if (smuggledId) {
      await db.delete(scheduleRules).where(eq(scheduleRules.id, smuggledId));
    }
  });
});

describe("schedule_executions — cross-tenant isolation (append-only)", () => {
  it("Tenant A's read scoped to Tenant A does not return Tenant B's execution", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: scheduleExecutions.id })
        .from(scheduleExecutions)
        .where(
          and(
            eq(scheduleExecutions.id, executionBId),
            eq(scheduleExecutions.tenantId, TENANT_A),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });

  it("RLS blocks inserting an execution row tagged with a different tenant_id under app_user role", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx.insert(scheduleExecutions).values({
          tenantId: TENANT_B,
          ruleId: ruleBId,
          scheduledAt: new Date("2026-11-01T09:00:00Z"),
          status: "success",
        });
      }),
    ).rejects.toBeTruthy();
  });

  it("app_user UPDATE fails with permission denied (append-only)", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx
          .update(scheduleExecutions)
          .set({ status: "failed" })
          .where(eq(scheduleExecutions.id, executionAId));
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("app_user DELETE fails with permission denied (append-only)", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx
          .delete(scheduleExecutions)
          .where(eq(scheduleExecutions.id, executionAId));
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});
