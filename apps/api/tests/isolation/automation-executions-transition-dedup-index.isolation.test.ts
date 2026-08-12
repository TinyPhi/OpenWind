/**
 * Isolation test for #143's partial unique index (migration 0054,
 * `automation_executions_rule_transition_success_idx` on
 * `(rule_id, transition_event_id) WHERE transition_event_id IS NOT NULL AND
 * status = 'success'`). The index does not include `tenant_id` directly —
 * PR #372 review (L3) asked for proof that two tenants using the same
 * `transitionEventId` don't collide. In practice this always holds because
 * `rule_id` is itself already tenant-scoped (a rule belongs to exactly one
 * tenant's `automation_rules` row), so the composite key never crosses a
 * tenant boundary — this test proves that directly against real Postgres
 * rather than leaving it as an unverified assumption.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  automationRules,
  automationExecutions,
} from "@platform/db";
import { createAutomationRule } from "@platform/automation-engine";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000372";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000372";
const SHARED_TRANSITION_EVENT_ID = "372e0000-0000-4000-8000-000000000000";

let ruleAId: string;
let ruleBId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Dedup Index Test A",
      slug: `dedup-idx-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Dedup Index Test B",
      slug: `dedup-idx-b-${TENANT_B}`,
    },
  ]);

  const ruleA = await createAutomationRule(db, TENANT_A, {
    name: "dedup-index-test-a",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    conditions: null,
    actions: [],
  });
  ruleAId = ruleA.id;

  const ruleB = await createAutomationRule(db, TENANT_B, {
    name: "dedup-index-test-b",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    conditions: null,
    actions: [],
  });
  ruleBId = ruleB.id;
});

afterAll(async () => {
  await withTenantContext(TENANT_A, (tx) =>
    tx
      .delete(automationExecutions)
      .where(eq(automationExecutions.tenantId, TENANT_A)),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx
      .delete(automationExecutions)
      .where(eq(automationExecutions.tenantId, TENANT_B)),
  );
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(automationRules).where(eq(automationRules.tenantId, TENANT_A)),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.delete(automationRules).where(eq(automationRules.tenantId, TENANT_B)),
  );
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

describe("automation_executions_rule_transition_success_idx — cross-tenant scoping (#372 review L3)", () => {
  it("two tenants successfully completing a rule with the same transitionEventId don't collide", async () => {
    await withTenantContext(TENANT_A, (tx) =>
      tx.insert(automationExecutions).values({
        tenantId: TENANT_A,
        ruleId: ruleAId,
        triggerEvent: {},
        status: "success",
        transitionEventId: SHARED_TRANSITION_EVENT_ID,
      }),
    );

    // Same transitionEventId, different tenant AND different ruleId — the
    // composite (rule_id, transition_event_id) key never actually collides
    // across tenants because rule_id is itself tenant-scoped.
    await withTenantContext(TENANT_B, (tx) =>
      tx.insert(automationExecutions).values({
        tenantId: TENANT_B,
        ruleId: ruleBId,
        triggerEvent: {},
        status: "success",
        transitionEventId: SHARED_TRANSITION_EVENT_ID,
      }),
    );

    const [rowA] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(automationExecutions)
        .where(eq(automationExecutions.tenantId, TENANT_A)),
    );
    const [rowB] = await withTenantContext(TENANT_B, (tx) =>
      tx
        .select()
        .from(automationExecutions)
        .where(eq(automationExecutions.tenantId, TENANT_B)),
    );
    expect(rowA?.transitionEventId).toBe(SHARED_TRANSITION_EVENT_ID);
    expect(rowB?.transitionEventId).toBe(SHARED_TRANSITION_EVENT_ID);
  });

  it("a second success row for the SAME (ruleId, transitionEventId) pair is rejected as a unique violation", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(automationExecutions).values({
          tenantId: TENANT_A,
          ruleId: ruleAId,
          triggerEvent: {},
          status: "success",
          transitionEventId: SHARED_TRANSITION_EVENT_ID,
        }),
      ),
    ).rejects.toThrow();
  });
});
