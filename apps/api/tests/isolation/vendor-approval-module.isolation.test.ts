/**
 * Tenant isolation for @modules/vendor-approval (issue #606, spec R8).
 *
 * Installs the real seed SQL into tenant A only, then reads every table the
 * seed writes to from inside tenant B's context (withTenantContext switches to
 * app_user, so RLS is enforced) with NO explicit tenant filter — any row that
 * comes back is an RLS leak. Also checks that tenant B cannot transition a
 * tenant-A vendor even with every department role.
 *
 * Requires a live Postgres instance (docker compose up -d).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  tenants,
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
  withTenantContext,
} from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import { executeTransition, WorkflowError } from "@platform/workflow-engine";
import { ModuleService } from "../../src/services/module-service.js";

const TENANT_A = "aaaaaaaa-0606-4000-a000-000000000606";
const TENANT_B = "bbbbbbbb-0606-4000-b000-000000000606";
const ALL_ROLES = [
  "admin",
  "agent",
  "it_security",
  "legal",
  "finance_approver",
];

let vendorIdA: string;
let submitTransitionIdA: string;

beforeAll(async () => {
  for (const id of [TENANT_A, TENANT_B]) {
    await db
      .insert(tenants)
      .values({
        id,
        name: `Vendor Approval Isolation ${id}`,
        slug: `vendor-approval-iso-${id}`,
        plan: "standard",
        status: "active",
        config: {},
      })
      .onConflictDoNothing();
  }
  await ModuleService.seedRegistry();
  await ModuleService.installModule(TENANT_A, "vendor-approval");

  const [et] = await db
    .select()
    .from(entityTypes)
    .where(
      and(eq(entityTypes.tenantId, TENANT_A), eq(entityTypes.name, "vendor")),
    );
  if (!et) throw new Error("setup: vendor entity type not seeded for A");
  const [wf] = await db
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.tenantId, TENANT_A), eq(workflows.entityTypeId, et.id)),
    );
  if (!wf) throw new Error("setup: vendor workflow not seeded for A");
  const [submit] = await db
    .select()
    .from(workflowTransitions)
    .where(
      and(
        eq(workflowTransitions.workflowId, wf.id),
        eq(workflowTransitions.fromState, "draft"),
      ),
    );
  if (!submit) throw new Error("setup: draft transition not seeded for A");
  submitTransitionIdA = submit.id;

  const vendor = await withTenantContext(TENANT_A, (tx) =>
    createEntity(tx, TENANT_A, {
      entityTypeId: et.id,
      workflowId: wf.id,
      createdBy: "u-a",
      fields: {
        vendor_name: "Tenant A Vendor",
        category: "software",
        contact_email: "a@vendor.example",
        annual_spend_estimate: { amount: 1000, currency: "INR" },
        business_justification: "A only",
        security_questionnaire: "file-a",
      },
    }),
  );
  vendorIdA = vendor.id;
});

afterAll(async () => {
  for (const id of [TENANT_A, TENANT_B]) {
    const instances = await db
      .select({ id: entityInstances.id })
      .from(entityInstances)
      .where(eq(entityInstances.tenantId, id));
    const ids = instances.map((i) => i.id);
    if (ids.length > 0) {
      await db
        .delete(workflowEvents)
        .where(inArray(workflowEvents.instanceId, ids));
    }
    await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, id));
    await db.delete(entityInstances).where(eq(entityInstances.tenantId, id));
    await db.delete(automationRules).where(eq(automationRules.tenantId, id));
    await db
      .delete(workflowTransitions)
      .where(eq(workflowTransitions.tenantId, id));
    await db.delete(workflowStates).where(eq(workflowStates.tenantId, id));
    await db.delete(workflows).where(eq(workflows.tenantId, id));
    await db.delete(entityFields).where(eq(entityFields.tenantId, id));
    await db.delete(entityTypes).where(eq(entityTypes.tenantId, id));
    await db.delete(viewConfigs).where(eq(viewConfigs.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
});

describe("vendor-approval module — tenant isolation", () => {
  it("tenant B sees none of tenant A's seeded config or records under RLS", async () => {
    const leaked = await withTenantContext(TENANT_B, async (tx) => ({
      entityTypes: await tx.select().from(entityTypes),
      entityFields: await tx.select().from(entityFields),
      workflows: await tx.select().from(workflows),
      workflowStates: await tx.select().from(workflowStates),
      workflowTransitions: await tx.select().from(workflowTransitions),
      automationRules: await tx.select().from(automationRules),
      viewConfigs: await tx.select().from(viewConfigs),
      entityInstances: await tx.select().from(entityInstances),
    }));
    for (const [table, rows] of Object.entries(leaked)) {
      const fromA = rows.filter(
        (r: { tenantId: string | null }) => r.tenantId === TENANT_A,
      );
      expect(fromA, `${table} leaked tenant A rows`).toHaveLength(0);
    }
  });

  it("tenant B cannot transition a tenant A vendor, even holding every department role", async () => {
    const err: unknown = await withTenantContext(TENANT_B, (tx) =>
      executeTransition(tx, TENANT_B, {
        instanceId: vendorIdA,
        transitionId: submitTransitionIdA,
        actorId: "u-b",
        actorRoles: ALL_ROLES,
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    // Narrowed by the toBeInstanceOf assertion above.
    expect((err as WorkflowError).code).toBe("INSTANCE_NOT_FOUND");

    const [row] = await db
      .select({ currentState: entityInstances.currentState })
      .from(entityInstances)
      .where(eq(entityInstances.id, vendorIdA));
    expect(row?.currentState).toBe("draft");
  });

  it("installing in tenant B creates B's own rows without touching A's", async () => {
    await ModuleService.installModule(TENANT_B, "vendor-approval");
    const countFor = async (tenantId: string): Promise<number> =>
      (
        await db
          .select()
          .from(workflowTransitions)
          .where(eq(workflowTransitions.tenantId, tenantId))
      ).length;
    expect(await countFor(TENANT_A)).toBe(7);
    expect(await countFor(TENANT_B)).toBe(7);
  });
});
