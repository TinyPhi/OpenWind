/**
 * #944 — the workflow_states / workflows lookups in createEntity now carry an
 * explicit tenant filter next to RLS. Behaviour must be unchanged for the
 * owning tenant, and another tenant must never resolve this tenant's states.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenantContext, outboxEvents } from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import { createWorkflow, addWorkflowState } from "@platform/workflow-engine";

const TENANT = "eeeeeeee-0000-4000-e000-000000000944";
const OTHER_TENANT = "eeeeeeee-0000-4000-e000-000000000945";
const CALLER = { userId: "test-actor", isGlobalAdmin: true };

afterAll(async () => {
  for (const tenantId of [TENANT, OTHER_TENANT]) {
    await withTenantContext(tenantId, async (tx) => {
      await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, tenantId));
    });
  }
});

async function seedWorkflow(): Promise<{
  entityTypeId: string;
  workflowId: string;
}> {
  const entityType = await createEntityType(db, TENANT, {
    name: `t944_ticket_${Date.now()}`,
    plural: "t944_tickets",
    allowCustomFields: true,
  });
  const workflow = await createWorkflow(db, TENANT, CALLER.userId, {
    entityTypeId: entityType.id,
    name: `t944_workflow_${Date.now()}`,
    initialState: "open",
  });
  await addWorkflowState(db, TENANT, workflow.id, CALLER, {
    name: "open",
    label: "Open",
    isTerminal: false,
    sortOrder: 0,
  });
  await addWorkflowState(db, TENANT, workflow.id, CALLER, {
    name: "done",
    label: "Done",
    isTerminal: true,
    sortOrder: 1,
  });
  return { entityTypeId: entityType.id, workflowId: workflow.id };
}

describe("explicit tenant filter on workflow-state lookups in createEntity (#944)", () => {
  it("resolves the workflow's initial state for the owning tenant", async () => {
    const { entityTypeId, workflowId } = await seedWorkflow();
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId,
        workflowId,
        fields: { title: "initial state" },
      }),
    );
    expect(instance.currentState).toBe("open");
  });

  it("accepts a valid explicit state and rejects an unknown one", async () => {
    const { entityTypeId, workflowId } = await seedWorkflow();
    const done = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId,
        workflowId,
        currentState: "done",
        fields: { title: "explicit state" },
      }),
    );
    expect(done.currentState).toBe("done");

    await expect(
      withTenantContext(TENANT, (tx) =>
        createEntity(tx, TENANT, {
          entityTypeId,
          workflowId,
          currentState: "nope",
          fields: { title: "bad state" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("does not resolve another tenant's workflow states", async () => {
    const { entityTypeId, workflowId } = await seedWorkflow();
    await expect(
      withTenantContext(OTHER_TENANT, (tx) =>
        createEntity(tx, OTHER_TENANT, {
          entityTypeId,
          workflowId,
          currentState: "open",
          fields: { title: "cross tenant" },
        }),
      ),
    ).rejects.toThrow();
  });
});
