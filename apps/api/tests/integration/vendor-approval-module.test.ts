/**
 * @modules/vendor-approval (issue #606, docs/specs/vendor-approval.md).
 * Installs the real seed SQL into a fresh tenant and drives the real workflow
 * engine — covers R1 (install/idempotency/registry), R2 (department-role
 * guards), R3 (required fields + rejection comments) and R4 (rules seeded
 * disabled with no recipient).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import Redis from "ioredis";
import { env } from "@platform/config";
import {
  db,
  tenants,
  modules,
  entityTypes,
  entityFields,
  entityInstances,
  workflows,
  workflowStates,
  workflowTransitions,
  workflowEvents,
  automationRules,
  outboxEvents,
  viewConfigs,
  notifications,
  notificationRecipients,
  automationExecutions,
  withTenantContext,
} from "@platform/db";
import { executeAutomationRules } from "@platform/automation-engine";
import { createEntity } from "@platform/entity-engine";
import {
  executeTransition,
  getAvailableTransitions,
  WorkflowError,
} from "@platform/workflow-engine";
import { ModuleService } from "../../src/services/module-service.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000606";

const READY_FIELDS = {
  vendor_name: "Acme Analytics",
  category: "software",
  contact_email: "sales@acme.example",
  annual_spend_estimate: { amount: 120000, currency: "INR" },
  business_justification: "Replaces three spreadsheets used by finance.",
  security_questionnaire: "file-security-questionnaire",
};

let entityTypeId: string;
let workflowId: string;
const transitionIds = new Map<string, string>();

function tid(from: string, to: string): string {
  const id = transitionIds.get(`${from}->${to}`);
  if (!id) throw new Error(`transition ${from}->${to} not seeded`);
  return id;
}

async function newVendor(fields: Record<string, unknown>): Promise<string> {
  const instance = await withTenantContext(TENANT_ID, (tx) =>
    createEntity(tx, TENANT_ID, {
      entityTypeId,
      fields,
      createdBy: "u-requester",
      workflowId,
    }),
  );
  return instance.id;
}

async function transition(
  instanceId: string,
  from: string,
  to: string,
  actorRoles: string[],
  comment?: string,
): Promise<void> {
  await withTenantContext(TENANT_ID, (tx) =>
    executeTransition(tx, TENANT_ID, {
      instanceId,
      transitionId: tid(from, to),
      actorId: "u-actor",
      actorRoles,
      ...(comment !== undefined ? { comment } : {}),
    }),
  );
}

async function expectWorkflowError(
  p: Promise<unknown>,
  code: string,
): Promise<void> {
  const err: unknown = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowError);
  // Narrowed by the toBeInstanceOf assertion above.
  expect((err as WorkflowError).code).toBe(code);
}

async function currentState(instanceId: string): Promise<string | null> {
  const [row] = await db
    .select({ currentState: entityInstances.currentState })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, TENANT_ID),
      ),
    );
  return row?.currentState ?? null;
}

describe("vendor-approval module (#606)", () => {
  beforeAll(async () => {
    await db
      .insert(tenants)
      .values({
        id: TENANT_ID,
        name: "Vendor Approval Test Tenant",
        slug: "vendor-approval-test-tenant",
        plan: "standard",
        status: "active",
        config: {},
      })
      .onConflictDoNothing();
    await ModuleService.seedRegistry();
    await ModuleService.installModule(TENANT_ID, "vendor-approval");

    const [et] = await db
      .select()
      .from(entityTypes)
      .where(
        and(
          eq(entityTypes.tenantId, TENANT_ID),
          eq(entityTypes.name, "vendor"),
        ),
      );
    if (!et) throw new Error("vendor entity type not seeded");
    entityTypeId = et.id;

    const [wf] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, TENANT_ID),
          eq(workflows.entityTypeId, entityTypeId),
        ),
      );
    if (!wf) throw new Error("vendor workflow not seeded");
    workflowId = wf.id;

    const rows = await db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, workflowId));
    for (const t of rows)
      transitionIds.set(`${t.fromState}->${t.toState}`, t.id);
  });

  afterAll(async () => {
    const instances = await db
      .select({ id: entityInstances.id })
      .from(entityInstances)
      .where(eq(entityInstances.tenantId, TENANT_ID));
    const ids = instances.map((i) => i.id);
    if (ids.length > 0) {
      await db
        .delete(workflowEvents)
        .where(inArray(workflowEvents.instanceId, ids));
    }
    await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT_ID));
    await db
      .delete(notificationRecipients)
      .where(eq(notificationRecipients.tenantId, TENANT_ID));
    await db.delete(notifications).where(eq(notifications.tenantId, TENANT_ID));
    await db
      .delete(automationExecutions)
      .where(eq(automationExecutions.tenantId, TENANT_ID));
    await db
      .delete(entityInstances)
      .where(eq(entityInstances.tenantId, TENANT_ID));
    await db
      .delete(automationRules)
      .where(eq(automationRules.tenantId, TENANT_ID));
    await db
      .delete(workflowTransitions)
      .where(eq(workflowTransitions.tenantId, TENANT_ID));
    await db
      .delete(workflowStates)
      .where(eq(workflowStates.tenantId, TENANT_ID));
    await db.delete(workflows).where(eq(workflows.tenantId, TENANT_ID));
    await db.delete(entityFields).where(eq(entityFields.tenantId, TENANT_ID));
    await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT_ID));
    await db.delete(viewConfigs).where(eq(viewConfigs.tenantId, TENANT_ID));
    await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
  });

  describe("R1 — registry + install", () => {
    it("is registered as an optional module", async () => {
      const [mod] = await db
        .select()
        .from(modules)
        .where(eq(modules.slug, "vendor-approval"));
      expect(mod?.category).toBe("optional");
      expect(mod?.isSystem).toBe(false);
    });

    it("seeds fields, six states with 48h SLA on review states, and seven transitions", async () => {
      const fields = await db
        .select({ name: entityFields.name })
        .from(entityFields)
        .where(eq(entityFields.entityTypeId, entityTypeId));
      expect(fields.map((f) => f.name).sort()).toEqual(
        [
          "annual_spend_estimate",
          "business_justification",
          "category",
          "contact_email",
          "contract_draft",
          "external_ref",
          "security_questionnaire",
          "source_system",
          "vendor_name",
        ].sort(),
      );

      const states = await db
        .select()
        .from(workflowStates)
        .where(eq(workflowStates.workflowId, workflowId));
      const sla = Object.fromEntries(states.map((s) => [s.name, s.slaHours]));
      expect(sla).toEqual({
        draft: null,
        it_security_review: 48,
        legal_review: 48,
        pending_final_approval: 48,
        approved: null,
        rejected: null,
      });
      expect(
        states
          .filter((s) => s.isTerminal)
          .map((s) => s.name)
          .sort(),
      ).toEqual(["approved", "rejected"]);
      expect(transitionIds.size).toBe(7);
    });

    it("seeds a view config for the vendor entity type", async () => {
      const rows = await db
        .select()
        .from(viewConfigs)
        .where(
          and(
            eq(viewConfigs.tenantId, TENANT_ID),
            eq(viewConfigs.entityTypeSlug, "vendor"),
          ),
        );
      expect(rows).toHaveLength(1);
    });

    it("re-running the seed SQL is a no-op (idempotent)", async () => {
      // installModule short-circuits on installed_modules, so clear the
      // marker to force the seed files to run a second time.
      await db
        .update(tenants)
        .set({ config: {} })
        .where(eq(tenants.id, TENANT_ID));
      await ModuleService.installModule(TENANT_ID, "vendor-approval");

      const types = await db
        .select()
        .from(entityTypes)
        .where(
          and(
            eq(entityTypes.tenantId, TENANT_ID),
            eq(entityTypes.name, "vendor"),
          ),
        );
      const wfs = await db
        .select()
        .from(workflows)
        .where(eq(workflows.tenantId, TENANT_ID));
      const rules = await db
        .select()
        .from(automationRules)
        .where(eq(automationRules.tenantId, TENANT_ID));
      const fields = await db
        .select()
        .from(entityFields)
        .where(eq(entityFields.entityTypeId, entityTypeId));
      expect(types).toHaveLength(1);
      expect(wfs).toHaveLength(1);
      expect(rules).toHaveLength(3);
      expect(fields).toHaveLength(9);

      // 002 deletes + re-inserts transitions, so refresh the id map.
      const rows = await db
        .select()
        .from(workflowTransitions)
        .where(eq(workflowTransitions.workflowId, workflowId));
      expect(rows).toHaveLength(7);
      transitionIds.clear();
      for (const t of rows)
        transitionIds.set(`${t.fromState}->${t.toState}`, t.id);
    });
  });

  describe("R2 — department role guards", () => {
    it("walks Draft → Approved with each department role", async () => {
      const id = await newVendor(READY_FIELDS);
      await transition(id, "draft", "it_security_review", ["agent"]);
      await transition(id, "it_security_review", "legal_review", [
        "agent",
        "it_security",
      ]);
      await db
        .update(entityInstances)
        .set({
          fields: { ...READY_FIELDS, contract_draft: "file-contract-draft" },
        })
        .where(eq(entityInstances.id, id));
      await transition(id, "legal_review", "pending_final_approval", [
        "agent",
        "legal",
      ]);
      await transition(id, "pending_final_approval", "approved", [
        "agent",
        "finance_approver",
      ]);
      expect(await currentState(id)).toBe("approved");
    });

    it("forbids a plain agent, and the wrong department, at each review stage", async () => {
      const id = await newVendor({
        ...READY_FIELDS,
        contract_draft: "file-contract-draft",
      });
      await transition(id, "draft", "it_security_review", ["agent"]);
      await expectWorkflowError(
        transition(id, "it_security_review", "legal_review", ["agent"]),
        "TRANSITION_FORBIDDEN",
      );
      await expectWorkflowError(
        transition(id, "it_security_review", "legal_review", [
          "agent",
          "legal",
        ]),
        "TRANSITION_FORBIDDEN",
      );

      await transition(id, "it_security_review", "legal_review", ["admin"]);
      await expectWorkflowError(
        transition(id, "legal_review", "pending_final_approval", [
          "agent",
          "it_security",
        ]),
        "TRANSITION_FORBIDDEN",
      );

      await transition(id, "legal_review", "pending_final_approval", ["admin"]);
      await expectWorkflowError(
        transition(id, "pending_final_approval", "approved", [
          "agent",
          "legal",
        ]),
        "TRANSITION_FORBIDDEN",
      );
      expect(await currentState(id)).toBe("pending_final_approval");
    });

    it("hides review transitions from actors without the department role", async () => {
      const id = await newVendor(READY_FIELDS);
      await transition(id, "draft", "it_security_review", ["agent"]);

      const forAgent = await withTenantContext(TENANT_ID, (tx) =>
        getAvailableTransitions(tx, TENANT_ID, id, ["agent"]),
      );
      expect(forAgent).toHaveLength(0);

      const forSecurity = await withTenantContext(TENANT_ID, (tx) =>
        getAvailableTransitions(tx, TENANT_ID, id, ["agent", "it_security"]),
      );
      expect(forSecurity.map((t) => t.toState).sort()).toEqual([
        "legal_review",
        "rejected",
      ]);
    });
  });

  describe("R3 — required fields and comments", () => {
    it("blocks submission until justification fields and the security questionnaire are present", async () => {
      const id = await newVendor({
        vendor_name: "Bare Vendor",
        category: "services",
      });
      await expectWorkflowError(
        transition(id, "draft", "it_security_review", ["agent"]),
        "REQUIRED_FIELDS_MISSING",
      );
      expect(await currentState(id)).toBe("draft");
    });

    it("blocks legal approval until a contract draft is attached", async () => {
      const id = await newVendor(READY_FIELDS);
      await transition(id, "draft", "it_security_review", ["agent"]);
      await transition(id, "it_security_review", "legal_review", ["admin"]);
      await expectWorkflowError(
        transition(id, "legal_review", "pending_final_approval", ["legal"]),
        "REQUIRED_FIELDS_MISSING",
      );
    });

    it("requires a comment to reject, and rejection is terminal", async () => {
      const id = await newVendor(READY_FIELDS);
      await transition(id, "draft", "it_security_review", ["agent"]);
      await expectWorkflowError(
        transition(id, "it_security_review", "rejected", ["it_security"]),
        "REQUIRED_FIELDS_MISSING",
      );
      await transition(
        id,
        "it_security_review",
        "rejected",
        ["it_security"],
        "SOC 2 report missing",
      );
      expect(await currentState(id)).toBe("rejected");

      const outgoing = await withTenantContext(TENANT_ID, (tx) =>
        getAvailableTransitions(tx, TENANT_ID, id, ["admin"]),
      );
      expect(outgoing).toHaveLength(0);
    });
  });

  describe("R3 — rejection at every review stage", () => {
    it("requires a comment to reject at legal review and at final approval", async () => {
      const atLegal = await newVendor(READY_FIELDS);
      await transition(atLegal, "draft", "it_security_review", ["agent"]);
      await transition(atLegal, "it_security_review", "legal_review", [
        "it_security",
      ]);
      await expectWorkflowError(
        transition(atLegal, "legal_review", "rejected", ["legal"]),
        "REQUIRED_FIELDS_MISSING",
      );
      await transition(
        atLegal,
        "legal_review",
        "rejected",
        ["legal"],
        "Indemnity clause unacceptable",
      );
      expect(await currentState(atLegal)).toBe("rejected");

      const atFinal = await newVendor({
        ...READY_FIELDS,
        contract_draft: "file-contract-draft",
      });
      await transition(atFinal, "draft", "it_security_review", ["agent"]);
      await transition(atFinal, "it_security_review", "legal_review", [
        "it_security",
      ]);
      await transition(atFinal, "legal_review", "pending_final_approval", [
        "legal",
      ]);
      await expectWorkflowError(
        transition(atFinal, "pending_final_approval", "rejected", [
          "finance_approver",
        ]),
        "REQUIRED_FIELDS_MISSING",
      );
      await expectWorkflowError(
        transition(
          atFinal,
          "pending_final_approval",
          "rejected",
          ["legal"],
          "wrong department",
        ),
        "TRANSITION_FORBIDDEN",
      );
      await transition(
        atFinal,
        "pending_final_approval",
        "rejected",
        ["finance_approver"],
        "Over budget for this quarter",
      );
      expect(await currentState(atFinal)).toBe("rejected");
    });
  });

  describe("SLA scheduling", () => {
    it("schedules a 48h SLA on entry to each review state, and none for draft or terminal states", async () => {
      const id = await newVendor({
        ...READY_FIELDS,
        contract_draft: "file-contract-draft",
      });
      await transition(id, "draft", "it_security_review", ["agent"]);
      await transition(id, "it_security_review", "legal_review", [
        "it_security",
      ]);
      await transition(id, "legal_review", "pending_final_approval", ["legal"]);
      await transition(id, "pending_final_approval", "approved", [
        "finance_approver",
      ]);

      const rows = await db
        .select({ payload: outboxEvents.payload })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.tenantId, TENANT_ID),
            eq(outboxEvents.eventType, "workflow.sla_scheduled"),
            sql`${outboxEvents.payload}->>'instanceId' = ${id}`,
          ),
        );
      // jsonb payload — shape written by workflow-engine's SLA scheduler
      const scheduled = rows
        .map((r) => r.payload as { stateName: string; slaHours: number })
        .map((p) => `${p.stateName}:${p.slaHours}`)
        .sort();
      expect(scheduled).toEqual([
        "it_security_review:48",
        "legal_review:48",
        "pending_final_approval:48",
      ]);
    });
  });

  describe("R4 — notify rules", () => {
    it("seeds one disabled notify rule per review state, with no recipient", async () => {
      const rules = await db
        .select()
        .from(automationRules)
        .where(eq(automationRules.tenantId, TENANT_ID));
      expect(rules).toHaveLength(3);
      for (const rule of rules) {
        expect(rule.isEnabled).toBe(false);
        expect(rule.triggerType).toBe("workflow.transitioned");
        // jsonb columns are untyped at the Drizzle layer.
        const actions = rule.actions as Array<{
          type: string;
          config: Record<string, unknown>;
        }>;
        expect(actions).toHaveLength(1);
        expect(actions[0]?.type).toBe("notify");
        expect(actions[0]?.config["recipientId"]).toBeUndefined();
      }
      const scoped = rules
        .map((r) => {
          // jsonb column — shape fixed by 003_automation_rules.sql.
          const cond = r.conditions as {
            children: Array<{ field: string; value: string }>;
          };
          const byField = Object.fromEntries(
            cond.children.map((c) => [c.field, c.value]),
          );
          expect(byField["entityTypeId"]).toBe(entityTypeId);
          return byField["toState"];
        })
        .sort();
      expect(scoped).toEqual([
        "it_security_review",
        "legal_review",
        "pending_final_approval",
      ]);
    });

    it("once enabled with a recipient, notifies on entry to its review state — and only for vendors", async () => {
      const recipientId = "u-legal-approver";
      const [legalRule] = await db
        .select()
        .from(automationRules)
        .where(
          and(
            eq(automationRules.tenantId, TENANT_ID),
            eq(
              automationRules.name,
              "Vendor approval: notify Legal on entry to legal_review",
            ),
          ),
        );
      if (!legalRule) throw new Error("legal notify rule not seeded");
      // jsonb column — shape fixed by 003_automation_rules.sql.
      const actions = legalRule.actions as Array<{
        type: string;
        config: Record<string, unknown>;
      }>;
      await db
        .update(automationRules)
        .set({
          isEnabled: true,
          actions: actions.map((a) => ({
            ...a,
            config: { ...a.config, recipientId },
          })),
        })
        .where(eq(automationRules.id, legalRule.id));

      const id = await newVendor(READY_FIELDS);
      const event = (
        entityTypeIdForEvent: string,
      ): Record<string, unknown> => ({
        version: 1,
        eventType: "workflow.transitioned",
        tenantId: TENANT_ID,
        instanceId: id,
        entityTypeId: entityTypeIdForEvent,
        workflowId,
        fromState: "it_security_review",
        toState: "legal_review",
        triggeredBy: "user",
        actorId: null,
        occurredAt: new Date().toISOString(),
      });
      const recipientRows = async (): Promise<unknown[]> =>
        db
          .select()
          .from(notificationRecipients)
          .where(
            and(
              eq(notificationRecipients.tenantId, TENANT_ID),
              eq(notificationRecipients.userId, recipientId),
            ),
          );

      // The executor's circuit breaker needs Redis for every action.
      const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
      try {
        // Same state name on some other entity type must not fire the rule.
        await executeAutomationRules(
          db,
          TENANT_ID,
          event("00000000-0000-4000-8000-000000000000"),
          0,
          redis,
        );
        expect(await recipientRows()).toHaveLength(0);

        await executeAutomationRules(
          db,
          TENANT_ID,
          event(entityTypeId),
          0,
          redis,
        );
        expect(await recipientRows()).toHaveLength(1);
      } finally {
        await redis.quit();
      }

      const [note] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.tenantId, TENANT_ID));
      expect(note?.title).toBe("Vendor awaiting Legal review");
    });
  });
});
