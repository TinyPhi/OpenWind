/**
 * Tenant isolation tests for the automation engine.
 *
 * Uses a real Postgres database (no mocks) to verify that automation rules,
 * executions, and rule data cannot be read or triggered across tenant boundaries.
 * Mirrors entity-engine.isolation.test.ts and workflow-engine.isolation.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { db, withTenantContext } from "@platform/db";
import { automationRules, automationExecutions } from "@platform/db";
import {
  createAutomationRule,
  listAutomationRules,
  getAutomationRule,
  executeAutomationRules,
  AutomationError,
} from "@platform/automation-engine";
import type { AuthContext } from "@platform/auth";
import { getAutomationRuleHandler } from "../../src/routes/automation-rules/get.js";
import { deleteAutomationRuleHandler } from "../../src/routes/automation-rules/delete.js";

// ── Test tenant IDs ───────────────────────────────────────────────────────────

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000021";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000022";

// ── Shared state ──────────────────────────────────────────────────────────────

let ruleIdA: string | undefined;
let ruleIdB: string | undefined;

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const ruleA = await createAutomationRule(db, TENANT_A, {
    name: "Tenant A Rule",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    actions: [{ type: "notify", config: {} }],
  });
  ruleIdA = ruleA.id;

  const ruleB = await createAutomationRule(db, TENANT_B, {
    name: "Tenant B Rule",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    actions: [{ type: "notify", config: {} }],
  });
  ruleIdB = ruleB.id;
});

afterAll(async () => {
  // Delete executions first (FK references rules) then rules.
  // Scoped by both tenantId and id so that a partial beforeAll failure
  // (where ruleIdA is set but ruleIdB is not) still cleans up what exists
  // without accidentally deleting rows from other test runs sharing the DB.
  await db
    .delete(automationExecutions)
    .where(eq(automationExecutions.tenantId, TENANT_A));
  await db
    .delete(automationExecutions)
    .where(eq(automationExecutions.tenantId, TENANT_B));
  if (ruleIdA) {
    await db
      .delete(automationRules)
      .where(
        and(
          eq(automationRules.id, ruleIdA),
          eq(automationRules.tenantId, TENANT_A),
        ),
      );
  }
  if (ruleIdB) {
    await db
      .delete(automationRules)
      .where(
        and(
          eq(automationRules.id, ruleIdB),
          eq(automationRules.tenantId, TENANT_B),
        ),
      );
  }
});

// ── List isolation ─────────────────────────────────────────────────────────────

describe("listAutomationRules — cross-tenant isolation", () => {
  it("Tenant A list returns no Tenant B rules", async () => {
    const rules = await listAutomationRules(db, TENANT_A);
    const tenantBRules = rules.filter((r) => r.tenantId === TENANT_B);
    expect(tenantBRules).toHaveLength(0);
  });

  it("Tenant A list contains only Tenant A rules", async () => {
    const rules = await listAutomationRules(db, TENANT_A);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.tenantId === TENANT_A)).toBe(true);
  });
});

// ── Get isolation ──────────────────────────────────────────────────────────────

describe("getAutomationRule — cross-tenant isolation", () => {
  it("throws RULE_NOT_FOUND when Tenant A reads Tenant B rule ID", async () => {
    const err = await getAutomationRule(db, TENANT_A, ruleIdB).catch((e) => e);
    expect(err).toBeInstanceOf(AutomationError);
    expect((err as AutomationError).code).toBe("RULE_NOT_FOUND");
  });

  it("Tenant B can read its own rule", async () => {
    const rule = await getAutomationRule(db, TENANT_B, ruleIdB);
    expect(rule.id).toBe(ruleIdB);
    expect(rule.tenantId).toBe(TENANT_B);
  });
});

// ── Executor isolation ─────────────────────────────────────────────────────────

describe("executeAutomationRules — cross-tenant isolation", () => {
  const TRIGGER_EVENT = {
    version: 1 as const,
    eventType: "workflow.transitioned" as const,
    tenantId: TENANT_A,
    instanceId: "00000000-0000-0000-0000-000000000099",
    entityTypeId: "00000000-0000-0000-0000-000000000098",
    workflowId: "00000000-0000-0000-0000-000000000097",
    fromState: "open",
    toState: "closed",
    triggeredBy: "user" as const,
    actorId: null,
    occurredAt: new Date().toISOString(),
  };

  it("Tenant A event only triggers Tenant A rules, not Tenant B rules", async () => {
    await executeAutomationRules(db, TENANT_A, TRIGGER_EVENT);

    // Verify execution rows were created for Tenant A rule only
    const execsA = await db
      .select()
      .from(automationExecutions)
      .where(eq(automationExecutions.ruleId, ruleIdA));
    const execsB = await db
      .select()
      .from(automationExecutions)
      .where(eq(automationExecutions.ruleId, ruleIdB));

    expect(execsA.length).toBeGreaterThan(0);
    expect(execsB).toHaveLength(0);
  });
});

// ── Execution log isolation ────────────────────────────────────────────────────

describe("automation_executions — cross-tenant query isolation", () => {
  // Seed a real Tenant B execution row so the RLS assertion below has
  // something to leak — without this, the query returns zero rows regardless
  // of whether RLS works, and the test would pass vacuously.
  beforeAll(async () => {
    await executeAutomationRules(db, TENANT_B, {
      version: 1,
      eventType: "workflow.transitioned",
      tenantId: TENANT_B,
      instanceId: "00000000-0000-0000-0000-000000000199",
      entityTypeId: "00000000-0000-0000-0000-000000000198",
      workflowId: "00000000-0000-0000-0000-000000000197",
      fromState: "open",
      toState: "closed",
      triggeredBy: "user",
      actorId: null,
      occurredAt: new Date().toISOString(),
    });
  });

  it("sanity check: Tenant B execution row exists via superuser query", async () => {
    const execsB = await db
      .select({ id: automationExecutions.id })
      .from(automationExecutions)
      .where(eq(automationExecutions.ruleId, ruleIdB));
    expect(execsB.length).toBeGreaterThan(0);
  });

  // withTenantContext now issues SET LOCAL ROLE app_user (#121), so RLS
  // applies even though CI connects as the `platform` superuser. This query
  // deliberately omits an explicit tenant_id filter to isolate the RLS layer
  // from the engine-level WHERE-clause guard (tested elsewhere in this file).
  it("direct SELECT within Tenant A context returns no Tenant B executions", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: automationExecutions.id })
        .from(automationExecutions)
        .where(eq(automationExecutions.ruleId, ruleIdB));
      expect(rows).toHaveLength(0);
    });
  });
});

// ── HTTP route-level isolation ─────────────────────────────────────────────────

describe("GET /automation-rules/:id — HTTP cross-tenant isolation", () => {
  function makeApp(tenantId: string) {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use(
      "*",
      async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
        c.set("auth", {
          tenantId,
          userId: "u-aaa",
          roles: ["admin"],
          email: "test@example.com",
        });
        await next();
      },
    );
    app.get("/:id", ...getAutomationRuleHandler);
    app.delete("/:id", ...deleteAutomationRuleHandler);
    return app;
  }

  it("returns 404 when Tenant A GETs Tenant B rule ID", async () => {
    const res = await makeApp(TENANT_A).request(`/${ruleIdB}`);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("RULE_NOT_FOUND");
  });

  it("returns 404 when Tenant A DELETEs Tenant B rule ID", async () => {
    const res = await makeApp(TENANT_A).request(`/${ruleIdB}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
