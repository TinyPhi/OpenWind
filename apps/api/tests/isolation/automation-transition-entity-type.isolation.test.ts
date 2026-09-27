/**
 * #678 R6: a transition performed by an automation re-enters the executor with
 * a workflow.transitioned event. That event must carry the *transitioned*
 * instance's entity type — not the triggering event's, and never the instance
 * id — or rules scoped by entityTypeId silently miss it once trigger_config
 * is enforced.
 *
 * Setup: rule A fires on a ticket being created and transitions a separate
 * *order* to done. Rule B is scoped to orders reaching done; rule C to tickets
 * reaching done. Only B may fire.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import Redis from "ioredis";
import {
  db,
  tenants,
  withTenantContext,
  automationRules,
  automationExecutions,
  outboxEvents,
  workflowEvents,
  entityInstances,
  workflowTransitions,
  workflowStates,
  workflows,
  entityTypes,
  entityFields,
} from "@platform/db";
import { env } from "@platform/config";
import { createEntityType, createEntity } from "@platform/entity-engine";
import {
  createWorkflow,
  addWorkflowState,
  addWorkflowTransition,
} from "@platform/workflow-engine";
import {
  createAutomationRule,
  executeAutomationRules,
} from "@platform/automation-engine";

const TENANT = "cccccccc-0678-4000-c000-000000000011";
const caller = { userId: "test-actor", isGlobalAdmin: true };

let redis: Redis;
let ticketTypeId: string;
let orderTypeId: string;
let orderInstanceId: string;
let orderDoneTransitionId: string;
let ruleB: string;
let ruleC: string;

async function typeWithWorkflow(
  name: string,
): Promise<{ typeId: string; workflowId: string; doneId: string }> {
  const et = await createEntityType(db, TENANT, {
    name: `${name}_${Date.now()}`,
    plural: `${name}s`,
    allowCustomFields: true,
  });
  const wf = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: et.id,
    name: `${name}_wf_${Date.now()}`,
    initialState: "open",
  });
  await addWorkflowState(db, TENANT, wf.id, caller, {
    name: "open",
    label: "Open",
    isTerminal: false,
    sortOrder: 0,
  });
  await addWorkflowState(db, TENANT, wf.id, caller, {
    name: "done",
    label: "Done",
    isTerminal: true,
    sortOrder: 1,
  });
  const done = await addWorkflowTransition(db, TENANT, wf.id, caller, {
    fromState: "open",
    toState: "done",
  });
  return { typeId: et.id, workflowId: wf.id, doneId: done.id };
}

async function executionsFor(ruleId: string): Promise<number> {
  const rows = await db
    .select({ id: automationExecutions.id })
    .from(automationExecutions)
    .where(
      and(
        eq(automationExecutions.tenantId, TENANT),
        eq(automationExecutions.ruleId, ruleId),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  await db
    .insert(tenants)
    .values({ id: TENANT, name: "#678 R6", slug: `trigger-scope-r6-${TENANT}` })
    .onConflictDoNothing();

  const ticket = await typeWithWorkflow("r6_ticket");
  const order = await typeWithWorkflow("r6_order");
  ticketTypeId = ticket.typeId;
  orderTypeId = order.typeId;
  orderDoneTransitionId = order.doneId;

  const orderInstance = await withTenantContext(TENANT, (tx) =>
    createEntity(tx, TENANT, {
      entityTypeId: orderTypeId,
      workflowId: order.workflowId,
      fields: { title: "R6 order" },
    }),
  );
  orderInstanceId = orderInstance.id;

  await createAutomationRule(db, TENANT, {
    name: "A: ticket created → move the order to done",
    triggerType: "entity.created",
    triggerConfig: { entityTypeId: ticketTypeId },
    actions: [
      {
        type: "transition",
        config: {
          instanceId: orderInstanceId,
          transitionId: orderDoneTransitionId,
        },
      },
    ],
  });
  ruleB = (
    await createAutomationRule(db, TENANT, {
      name: "B: order reached done",
      triggerType: "workflow.transitioned",
      triggerConfig: { entityTypeId: orderTypeId, toState: "done" },
      actions: [],
    })
  ).id;
  ruleC = (
    await createAutomationRule(db, TENANT, {
      name: "C: ticket reached done",
      triggerType: "workflow.transitioned",
      triggerConfig: { entityTypeId: ticketTypeId, toState: "done" },
      actions: [],
    })
  ).id;
});

afterAll(async () => {
  await redis.quit();
  await db
    .delete(automationExecutions)
    .where(eq(automationExecutions.tenantId, TENANT));
  await db.delete(automationRules).where(eq(automationRules.tenantId, TENANT));
  await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
  await db.delete(workflowEvents).where(eq(workflowEvents.tenantId, TENANT));
  await db.delete(entityInstances).where(eq(entityInstances.tenantId, TENANT));
  await db
    .delete(workflowTransitions)
    .where(eq(workflowTransitions.tenantId, TENANT));
  await db.delete(workflowStates).where(eq(workflowStates.tenantId, TENANT));
  await db.delete(workflows).where(eq(workflows.tenantId, TENANT));
  await db.delete(entityFields).where(eq(entityFields.tenantId, TENANT));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

describe("automation-triggered transitions carry the right entity type (#678 R6)", () => {
  it("fires the rule scoped to the transitioned order, not the one scoped to the triggering ticket", async () => {
    await withTenantContext(TENANT, (tx) =>
      executeAutomationRules(
        tx,
        TENANT,
        {
          version: 1,
          eventType: "entity.created",
          tenantId: TENANT,
          instanceId: randomUUID(),
          entityTypeId: ticketTypeId,
          fields: {},
          createdBy: null,
        },
        0,
        redis,
      ),
    );

    const [order] = await db
      .select({ currentState: entityInstances.currentState })
      .from(entityInstances)
      .where(eq(entityInstances.id, orderInstanceId));
    expect(order?.currentState).toBe("done");
    expect(await executionsFor(ruleB)).toBe(1);
    expect(await executionsFor(ruleC)).toBe(0);
  });
});
