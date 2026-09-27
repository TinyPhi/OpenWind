/**
 * #678 / docs/specs/automation-trigger-config-scoping.md: a rule fires only for
 * events inside the scope its trigger_config names. Before the fix the executor
 * ignored trigger_config entirely, so every rule fired on every event of its
 * trigger type in the tenant.
 *
 * Drives the real executor against real Postgres with synthetic events, and
 * uses automation_executions rows as the observable — an out-of-scope rule
 * must leave none (R5). Rules have no actions, so nothing else is touched.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import Redis from "ioredis";
import {
  db,
  tenants,
  entityTypes,
  automationRules,
  automationExecutions,
} from "@platform/db";
import { env } from "@platform/config";
import {
  createAutomationRule,
  executeAutomationRules,
} from "@platform/automation-engine";

const TENANT = "cccccccc-0678-4000-c000-000000000001";
const OTHER_TENANT = "cccccccc-0678-4000-c000-000000000002";
const WF_A = randomUUID();
const WF_B = randomUUID();

let redis: Redis;
let ticketTypeId: string;
let orderTypeId: string;
let foreignTicketTypeId: string;

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

async function rule(
  triggerType: string,
  triggerConfig: Record<string, unknown>,
): Promise<string> {
  const created = await createAutomationRule(db, TENANT, {
    name: `#678 ${triggerType} ${JSON.stringify(triggerConfig)} ${randomUUID()}`,
    triggerType,
    triggerConfig,
    actions: [],
  });
  return created.id;
}

async function fire(event: Record<string, unknown>): Promise<void> {
  await executeAutomationRules(
    db,
    TENANT,
    {
      version: 1,
      tenantId: TENANT,
      instanceId: randomUUID(),
      ...event,
    },
    0,
    redis,
  );
}

function transitioned(
  workflowId: string,
  fromState: string | null,
  toState: string,
  entityTypeId = ticketTypeId,
): Record<string, unknown> {
  return {
    eventType: "workflow.transitioned",
    entityTypeId,
    workflowId,
    fromState,
    toState,
    triggeredBy: "user",
    actorId: null,
    occurredAt: new Date().toISOString(),
  };
}

function created(entityTypeId: string): Record<string, unknown> {
  return {
    eventType: "entity.created",
    entityTypeId,
    fields: {},
    createdBy: null,
  };
}

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  for (const id of [TENANT, OTHER_TENANT]) {
    await db
      .insert(tenants)
      .values({ id, name: `#678 ${id}`, slug: `trigger-scope-${id}` })
      .onConflictDoNothing();
  }
  const insertType = async (
    tenantId: string,
    name: string,
  ): Promise<string> => {
    const [row] = await db
      .insert(entityTypes)
      .values({ tenantId, name, plural: `${name}s` })
      .returning();
    if (!row) throw new Error("entity type insert failed");
    return row.id;
  };
  ticketTypeId = await insertType(TENANT, "scope_ticket");
  orderTypeId = await insertType(TENANT, "scope_order");
  // Same name as TENANT's ticket type — must never satisfy TENANT's rule.
  foreignTicketTypeId = await insertType(OTHER_TENANT, "scope_ticket");
});

afterAll(async () => {
  await redis.quit();
  await db
    .delete(automationExecutions)
    .where(eq(automationExecutions.tenantId, TENANT));
  await db.delete(automationRules).where(eq(automationRules.tenantId, TENANT));
  for (const id of [TENANT, OTHER_TENANT]) {
    await db.delete(entityTypes).where(eq(entityTypes.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
});

describe("trigger_config scoping (#678)", () => {
  it("workflow.transitioned honours workflowId and toState", async () => {
    const id = await rule("workflow.transitioned", {
      workflowId: WF_A,
      toState: "approved",
    });
    await fire(transitioned(WF_B, "open", "approved"));
    await fire(transitioned(WF_A, "open", "closed"));
    expect(await executionsFor(id)).toBe(0);

    await fire(transitioned(WF_A, "open", "approved"));
    expect(await executionsFor(id)).toBe(1);
  });

  it("workflow.transitioned honours fromState", async () => {
    const id = await rule("workflow.transitioned", { fromState: "review" });
    await fire(transitioned(WF_A, "open", "approved"));
    expect(await executionsFor(id)).toBe(0);
    await fire(transitioned(WF_A, "review", "approved"));
    expect(await executionsFor(id)).toBe(1);
  });

  it("workflow.sla_breached honours workflowId and state", async () => {
    const id = await rule("workflow.sla_breached", {
      workflowId: WF_A,
      state: "legal_review",
    });
    const breach = (
      workflowId: string,
      state: string,
    ): Record<string, unknown> => ({
      eventType: "workflow.sla_breached",
      entityTypeId: ticketTypeId,
      workflowId,
      state,
      slaHours: 48,
      breachedAt: new Date().toISOString(),
    });
    await fire(breach(WF_B, "legal_review"));
    await fire(breach(WF_A, "it_security_review"));
    expect(await executionsFor(id)).toBe(0);
    await fire(breach(WF_A, "legal_review"));
    expect(await executionsFor(id)).toBe(1);
  });

  it("entity events honour entityTypeId", async () => {
    const id = await rule("entity.created", { entityTypeId: ticketTypeId });
    await fire(created(orderTypeId));
    expect(await executionsFor(id)).toBe(0);
    await fire(created(ticketTypeId));
    expect(await executionsFor(id)).toBe(1);
  });

  it("the legacy seed form {entityType: name} matches by the event entity type's name", async () => {
    const id = await rule("entity.created", { entityType: "scope_ticket" });
    await fire(created(orderTypeId));
    // Another tenant's type with the same name is not this tenant's ticket.
    await fire(created(foreignTicketTypeId));
    expect(await executionsFor(id)).toBe(0);
    await fire(created(ticketTypeId));
    expect(await executionsFor(id)).toBe(1);
  });

  it("an empty config, empty strings and nulls still match every event", async () => {
    const empty = await rule("entity.created", {});
    const blanks = await rule("entity.created", {
      entityTypeId: "",
      entityType: null,
    });
    await fire(created(orderTypeId));
    await fire(created(ticketTypeId));
    expect(await executionsFor(empty)).toBe(2);
    expect(await executionsFor(blanks)).toBe(2);
  });
});
