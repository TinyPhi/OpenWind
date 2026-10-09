/**
 * T13 (docs/specs/multi-org-sandbox.md) -- confirms sandbox reset wipes only
 * business/module data (entity instances, workflow event history, automation execution
 * history) and leaves module CONFIG (entity_types/workflows/workflow_states/
 * workflow_transitions/automation_rules) and the tenant row itself untouched, so the
 * reseed step afterward has a real workflow to seed records into.
 *
 * Real Postgres and real Redis (RESET_TENANT_TABLES' deletes run for real, and
 * cancelQueuedJobsForTenant inspects real BullMQ queues) -- only module data reseeding is
 * short-circuited by giving the tenant an empty installed_modules list, so this test does
 * not depend on module seed SQL / entity-engine/workflow-engine machinery being installed
 * for the tenant, matching the narrow scope this test is actually checking (deletion
 * scope, not the reseed step, which sandbox-reset-worker.test.ts already covers as a unit).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityTypes,
  workflows,
  workflowStates,
  workflowTransitions,
  workflowEvents,
  entityInstances,
  automationRules,
  automationExecutions,
} from "@platform/db";
import { processSandboxResetJob } from "../../src/sandbox-reset-worker.js";

const TENANT_ID = "eeeeeeee-0160-4000-e000-000000000160";
let entityTypeId: string;
let workflowId: string;
let entityInstanceId: string;

beforeAll(async () => {
  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: "T13 sandbox-reset wipe-scope regression tenant",
      slug: `t13-reset-scope-${Date.now()}`,
      isSandbox: true,
      status: "active",
      config: { installed_modules: [] },
    })
    .onConflictDoNothing();

  const [etRow] = await db
    .insert(entityTypes)
    .values({
      tenantId: TENANT_ID,
      name: `t13_reset_type_${Date.now()}`,
      plural: `t13_reset_types_${Date.now()}`,
      allowCustomFields: false,
    })
    .returning();
  if (!etRow) throw new Error("entity type insert failed");
  entityTypeId = etRow.id;

  const [wfRow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT_ID,
      entityTypeId,
      name: "T13 Reset Scope Workflow",
      initialState: "open",
    })
    .returning();
  if (!wfRow) throw new Error("workflow insert failed");
  workflowId = wfRow.id;

  await db.insert(workflowStates).values([
    {
      tenantId: TENANT_ID,
      workflowId,
      name: "open",
      label: "Open",
      sortOrder: 0,
    },
    {
      tenantId: TENANT_ID,
      workflowId,
      name: "closed",
      label: "Closed",
      isTerminal: true,
      sortOrder: 1,
    },
  ]);
  await db.insert(workflowTransitions).values({
    tenantId: TENANT_ID,
    workflowId,
    fromState: "open",
    toState: "closed",
    label: "Close",
  });
  const [ruleRow] = await db
    .insert(automationRules)
    .values({
      tenantId: TENANT_ID,
      name: "T13 Reset Scope Rule",
      triggerType: "state_entered",
      triggerConfig: { state: "closed" },
      actions: [],
    })
    .returning();
  if (!ruleRow) throw new Error("automation rule insert failed");
  const ruleId = ruleRow.id;

  const [instanceRow] = await db
    .insert(entityInstances)
    .values({
      tenantId: TENANT_ID,
      entityTypeId,
      workflowId,
      currentState: "open",
      fields: {},
      createdBy: "system",
    })
    .returning();
  if (!instanceRow) throw new Error("entity instance insert failed");
  entityInstanceId = instanceRow.id;

  await db.insert(workflowEvents).values({
    tenantId: TENANT_ID,
    instanceId: entityInstanceId,
    workflowId,
    fromState: null,
    toState: "open",
    triggeredBy: "system",
    actorId: "system",
  });
  await db.insert(automationExecutions).values({
    tenantId: TENANT_ID,
    ruleId,
    triggerEvent: { type: "state_entered" },
    status: "succeeded",
  });
});

afterAll(async () => {
  // Best-effort cleanup -- the reset itself should already have removed the
  // instance-level rows; this also removes the config rows the reset deliberately leaves.
  await db
    .delete(workflowTransitions)
    .where(eq(workflowTransitions.workflowId, workflowId));
  await db
    .delete(workflowStates)
    .where(eq(workflowStates.workflowId, workflowId));
  await db
    .delete(automationRules)
    .where(eq(automationRules.tenantId, TENANT_ID));
  await db.delete(workflows).where(eq(workflows.tenantId, TENANT_ID));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
}, 30_000);

describe("sandbox reset: wipe scope (T13)", () => {
  it("wipes entity instances and workflow/automation execution history but leaves module config and the tenant row intact", async () => {
    await processSandboxResetJob({
      id: "t13-reset-scope-job",
      data: { tenantId: TENANT_ID, requestedBy: "admin-1" },
    });

    const remainingInstances = await db
      .select({ id: entityInstances.id })
      .from(entityInstances)
      .where(eq(entityInstances.tenantId, TENANT_ID));
    expect(remainingInstances).toHaveLength(0);

    const remainingEvents = await db
      .select({ id: workflowEvents.id })
      .from(workflowEvents)
      .where(eq(workflowEvents.tenantId, TENANT_ID));
    expect(remainingEvents).toHaveLength(0);

    const remainingExecutions = await db
      .select({ id: automationExecutions.id })
      .from(automationExecutions)
      .where(eq(automationExecutions.tenantId, TENANT_ID));
    expect(remainingExecutions).toHaveLength(0);

    // Module CONFIG must survive -- reset reseeds against it, it does not recreate it.
    const remainingStates = await db
      .select({ id: workflowStates.id })
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, workflowId));
    expect(remainingStates).toHaveLength(2);

    const remainingTransitions = await db
      .select({ id: workflowTransitions.id })
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, workflowId));
    expect(remainingTransitions).toHaveLength(1);

    const remainingWorkflows = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.tenantId, TENANT_ID));
    expect(remainingWorkflows).toHaveLength(1);

    const remainingEntityTypes = await db
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(eq(entityTypes.tenantId, TENANT_ID));
    expect(remainingEntityTypes).toHaveLength(1);

    const remainingRules = await db
      .select({ id: automationRules.id })
      .from(automationRules)
      .where(eq(automationRules.tenantId, TENANT_ID));
    expect(remainingRules).toHaveLength(1);

    // The tenant row itself is untouched -- reset is not a purge.
    const [tenantRow] = await db
      .select({ isSandbox: tenants.isSandbox, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID))
      .limit(1);
    expect(tenantRow?.isSandbox).toBe(true);
    expect(tenantRow?.status).toBe("active");
  }, 30_000);
});
