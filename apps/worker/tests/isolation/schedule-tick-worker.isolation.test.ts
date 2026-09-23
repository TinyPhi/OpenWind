/**
 * Tenant isolation for the temporal scheduler tick —
 * docs/specs/temporal-scheduler.md T14, R2/R7. Runs schedulerTick() end to
 * end against a real Postgres instance (no mocking of @platform/db),
 * proving the worker only ever creates tickets in the tenant that owns each
 * due schedule_rule, even when multiple tenants have rules due in the same
 * tick.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityInstances,
  scheduleRules,
  scheduleExecutions,
  adminAuditLog,
  tenantUsers,
} from "@platform/db";
import { createEntityType } from "@platform/entity-engine";
import type { EntityType } from "@platform/entity-engine";
import { schedulerTick } from "../../src/schedule-tick-worker.js";

const TENANT_A = "aaaaaaaa-2222-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-2222-4000-b000-000000000002";

let entityTypeA: EntityType;
let entityTypeB: EntityType;
let ruleAId: string;
let ruleBId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Schedule Tick Isolation A",
      slug: `schedule-tick-isolation-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Schedule Tick Isolation B",
      slug: `schedule-tick-isolation-b-${TENANT_B}`,
    },
  ]);

  // validateScheduleRuleRefs (packages/scheduler) requires the referenced
  // entity type be named exactly "ticket" (temporal-scheduler is scoped to
  // auto-creating tickets only, per docs/specs/temporal-scheduler.md §C) --
  // tenant-scoped, so each tenant can have its own "ticket" entity type here
  // without colliding.
  entityTypeA = await createEntityType(db, TENANT_A, {
    name: "ticket",
    plural: "tickets",
    allowCustomFields: true,
  });
  entityTypeB = await createEntityType(db, TENANT_B, {
    name: "ticket",
    plural: "tickets",
    allowCustomFields: true,
  });

  // Mandate-fields templates require a valid assignedTo, cross-tenant
  // validated against tenant_users (packages/scheduler/src/cross-tenant-refs.ts).
  await db.insert(tenantUsers).values([
    { tenantId: TENANT_A, userId: "aaaaaaaa-0000-4000-a000-0000000000aa" },
    { tenantId: TENANT_B, userId: "bbbbbbbb-0000-4000-b000-0000000000bb" },
  ]);

  const [ruleA] = await db
    .insert(scheduleRules)
    .values({
      tenantId: TENANT_A,
      name: "Weekly review A",
      cronExpr: "* * * * *",
      timezone: "UTC",
      entityTypeId: entityTypeA.id,
      template: {
        title: "Weekly review",
        assignedTo: "aaaaaaaa-0000-4000-a000-0000000000aa",
        due_days: 3,
        remark: "Auto-created weekly review",
      },
      status: "active",
      nextFireAt: new Date(Date.now() - 1000),
      createdBy: "u-a",
    })
    .returning({ id: scheduleRules.id });
  const [ruleB] = await db
    .insert(scheduleRules)
    .values({
      tenantId: TENANT_B,
      name: "Weekly review B",
      cronExpr: "* * * * *",
      timezone: "UTC",
      entityTypeId: entityTypeB.id,
      template: {
        title: "Weekly review",
        assignedTo: "bbbbbbbb-0000-4000-b000-0000000000bb",
        due_days: 3,
        remark: "Auto-created weekly review",
      },
      status: "active",
      nextFireAt: new Date(Date.now() - 1000),
      createdBy: "u-b",
    })
    .returning({ id: scheduleRules.id });
  ruleAId = ruleA!.id;
  ruleBId = ruleB!.id;
});

afterAll(async () => {
  await db
    .delete(scheduleExecutions)
    .where(inArray(scheduleExecutions.ruleId, [ruleAId, ruleBId]));
  await db
    .delete(scheduleRules)
    .where(inArray(scheduleRules.id, [ruleAId, ruleBId]));
  await db
    .delete(entityInstances)
    .where(
      inArray(entityInstances.entityTypeId, [entityTypeA.id, entityTypeB.id]),
    );
  await db
    .delete(adminAuditLog)
    .where(inArray(adminAuditLog.tenantId, [TENANT_A, TENANT_B]));
  await db
    .delete(tenantUsers)
    .where(inArray(tenantUsers.tenantId, [TENANT_A, TENANT_B]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("schedulerTick — tenant isolation", () => {
  it("creates each rule's ticket only in its own tenant, never crossing over", async () => {
    await schedulerTick();

    const instancesA = await db
      .select({ id: entityInstances.id, tenantId: entityInstances.tenantId })
      .from(entityInstances)
      .where(eq(entityInstances.entityTypeId, entityTypeA.id));
    const instancesB = await db
      .select({ id: entityInstances.id, tenantId: entityInstances.tenantId })
      .from(entityInstances)
      .where(eq(entityInstances.entityTypeId, entityTypeB.id));

    expect(instancesA).toHaveLength(1);
    expect(instancesA[0]?.tenantId).toBe(TENANT_A);
    expect(instancesB).toHaveLength(1);
    expect(instancesB[0]?.tenantId).toBe(TENANT_B);

    const executionsA = await db
      .select({
        tenantId: scheduleExecutions.tenantId,
        status: scheduleExecutions.status,
      })
      .from(scheduleExecutions)
      .where(eq(scheduleExecutions.ruleId, ruleAId));
    const executionsB = await db
      .select({
        tenantId: scheduleExecutions.tenantId,
        status: scheduleExecutions.status,
      })
      .from(scheduleExecutions)
      .where(eq(scheduleExecutions.ruleId, ruleBId));

    expect(executionsA).toHaveLength(1);
    expect(executionsA[0]?.tenantId).toBe(TENANT_A);
    expect(executionsA[0]?.status).toBe("success");
    expect(executionsB).toHaveLength(1);
    expect(executionsB[0]?.tenantId).toBe(TENANT_B);
    expect(executionsB[0]?.status).toBe("success");
  });
});
