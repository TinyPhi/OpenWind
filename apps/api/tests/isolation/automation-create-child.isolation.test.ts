/**
 * Proves #162: the "create_child" automation action type is now dispatched
 * by executor.ts's switch (packages/automation-engine/src/actions/create-child.ts)
 * — previously declared nowhere and silently no-op'd, per
 * modules/tender/README.md's now-resolved "Known gap". Runs the tender
 * module's exact rule shape end-to-end through a real automation rule
 * against a real database: on workflow.transitioned into a target state, a
 * child ticket is created with a description interpolated from the parent's
 * own fields, and the child's id is written back onto the parent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import Redis from "ioredis";
import {
  db,
  withTenantContext,
  tenants,
  workflows,
  workflowStates,
  workflowTransitions,
  workflowEvents,
  entityTypes,
  entityFields,
  entityInstances,
  entityRelations,
  outboxEvents,
  automationRules,
  automationExecutions,
} from "@platform/db";
import { env } from "@platform/config";
import {
  createEntityType,
  createEntity,
  getEntity,
  addEntityField,
} from "@platform/entity-engine";
import type { EntityType } from "@platform/entity-engine";
import {
  createAutomationRule,
  executeAutomationRules,
} from "@platform/automation-engine";

const TENANT = "ffffffff-0000-4000-f000-000000000162";

let entityType: EntityType;
let workflowId: string;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  await db
    .insert(tenants)
    .values({
      id: TENANT,
      name: "Isolation Create-Child Tenant",
      slug: `isolation-create-child-162-${Date.now()}`,
    })
    .onConflictDoNothing();

  entityType = await createEntityType(db, TENANT, {
    name: `create_child_ticket_${Date.now()}`,
    plural: "tickets",
    allowCustomFields: true,
  });

  for (const field of ["title", "summary", "description", "costing_child_id"]) {
    await addEntityField(db, TENANT, entityType.id, {
      name: field,
      label: field,
      fieldType: field === "costing_child_id" ? "entity_ref" : "text",
      config:
        field === "costing_child_id"
          ? { target_entity_type: entityType.name }
          : {},
      isRequired: false,
      isIndexed: false,
      isSystem: false,
      sortOrder: 0,
      sensitivity: "public",
    });
  }

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId: entityType.id,
      name: "Isolation create-child workflow",
      initialState: "draft",
      maxChildDepth: 1,
      maxChildrenPerParent: 10,
    })
    .returning({ id: workflows.id });
  workflowId = workflow!.id;

  await db.insert(workflowStates).values([
    {
      tenantId: TENANT,
      workflowId,
      name: "draft",
      label: "Draft",
      sortOrder: 0,
    },
    {
      tenantId: TENANT,
      workflowId,
      name: "pending_costing_review",
      label: "Pending Costing Review",
      sortOrder: 1,
    },
  ]);
});

afterAll(async () => {
  await redis.quit();
  await withTenantContext(TENANT, async (tx) => {
    await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
    await tx
      .delete(automationExecutions)
      .where(eq(automationExecutions.tenantId, TENANT));
    await tx
      .delete(automationRules)
      .where(eq(automationRules.tenantId, TENANT));
    await tx
      .delete(entityRelations)
      .where(eq(entityRelations.tenantId, TENANT));
    await tx.delete(workflowEvents).where(eq(workflowEvents.tenantId, TENANT));
    await tx
      .delete(entityInstances)
      .where(eq(entityInstances.tenantId, TENANT));
    await tx
      .delete(workflowTransitions)
      .where(eq(workflowTransitions.tenantId, TENANT));
    await tx.delete(workflowStates).where(eq(workflowStates.tenantId, TENANT));
    await tx.delete(workflows).where(eq(workflows.tenantId, TENANT));
    await tx.delete(entityFields).where(eq(entityFields.tenantId, TENANT));
    await tx.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  });
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

describe("automation 'create_child' action (#162)", () => {
  it("creates a child ticket with an interpolated description and writes the child id back onto the parent, via the tender module's exact rule shape", async () => {
    const parent = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: { title: "Tender A", summary: "Roof replacement" },
        workflowId,
        currentState: "draft",
      }),
    );

    await createAutomationRule(db, TENANT, {
      name: "Spawn costing child ticket on first entry to pending_costing_review",
      triggerType: "workflow.transitioned",
      triggerConfig: {},
      conditions: {
        op: "and",
        children: [
          { op: "eq", field: "toState", value: "pending_costing_review" },
          { op: "empty", field: "costing_child_id" },
        ],
      },
      actions: [
        {
          type: "create_child",
          config: {
            assignToUserId: null,
            descriptionTemplate: "{{title}}\n\n{{summary}}",
            writeBackField: "costing_child_id",
          },
        },
      ],
    });

    const before = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ id: entityInstances.id })
        .from(entityInstances)
        .where(eq(entityInstances.tenantId, TENANT)),
    );

    await executeAutomationRules(
      db,
      TENANT,
      {
        version: 1,
        eventType: "workflow.transitioned",
        tenantId: TENANT,
        instanceId: parent.id,
        entityTypeId: entityType.id,
        workflowId,
        fromState: "draft",
        toState: "pending_costing_review",
        triggeredBy: "user",
        actorId: null,
        occurredAt: new Date().toISOString(),
      },
      0,
      redis,
    );

    const after = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ id: entityInstances.id, fields: entityInstances.fields })
        .from(entityInstances)
        .where(eq(entityInstances.tenantId, TENANT)),
    );
    expect(after.length).toBe(before.length + 1);
    const child = after.find((r) => !before.some((b) => b.id === r.id));
    expect(
      (child?.fields as Record<string, unknown> | undefined)?.["description"],
    ).toBe("Tender A\n\nRoof replacement");

    const updatedParent = await withTenantContext(TENANT, (tx) =>
      getEntity(tx, TENANT, parent.id),
    );
    expect(updatedParent.fields["costing_child_id"]).toBe(child?.id);

    const relation = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(entityRelations)
        .where(
          and(
            eq(entityRelations.tenantId, TENANT),
            eq(entityRelations.fromInstanceId, parent.id),
            eq(entityRelations.relationType, "parent_of"),
          ),
        ),
    );
    expect(relation).toHaveLength(1);
    expect(relation[0]?.toInstanceId).toBe(child?.id);

    const executions = await db
      .select()
      .from(automationExecutions)
      .where(
        and(
          eq(automationExecutions.tenantId, TENANT),
          eq(automationExecutions.status, "success"),
        ),
      );
    expect(executions.length).toBeGreaterThan(0);

    // Re-fire the same rule against the same parent (e.g. a reject/reopen
    // loop back into pending_costing_review) — must not spawn a second
    // child. The rule's own condition tree can't detect this (see the
    // CONDITION NOTE in 003_automation_rules.sql); the guard is
    // create-child.ts's own check against the parent's current field value.
    await executeAutomationRules(
      db,
      TENANT,
      {
        version: 1,
        eventType: "workflow.transitioned",
        tenantId: TENANT,
        instanceId: parent.id,
        entityTypeId: entityType.id,
        workflowId,
        fromState: "draft",
        toState: "pending_costing_review",
        triggeredBy: "user",
        actorId: null,
        occurredAt: new Date().toISOString(),
      },
      0,
      redis,
    );

    const afterSecondFire = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ id: entityInstances.id })
        .from(entityInstances)
        .where(eq(entityInstances.tenantId, TENANT)),
    );
    expect(afterSecondFire.length).toBe(after.length);
  });
});
