/**
 * Proves #191: the "assign" and "create_entity" automation action types are
 * declared in packages/automation-engine/src/types.ts's ActionType union but
 * were never dispatched by executor.ts's switch — rules using them saved
 * successfully but silently did nothing. These tests run both actions
 * end-to-end through a real automation rule against a real database.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import Redis from "ioredis";
import {
  db,
  withTenantContext,
  outboxEvents,
  automationExecutions,
  entityInstances,
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

const TENANT = "ffffffff-0000-4000-f000-000000000191";

let entityType: EntityType;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  entityType = await createEntityType(db, TENANT, {
    name: `assign_create_ticket_${Date.now()}`,
    plural: "tickets",
    allowCustomFields: true,
  });

  // Registered so createEntity's field-schema validation actually persists
  // "title" instead of silently stripping the unrecognized key.
  await addEntityField(db, TENANT, entityType.id, {
    name: "title",
    label: "Title",
    fieldType: "text",
    config: {},
    isRequired: false,
    isIndexed: false,
    isSystem: false,
    sortOrder: 0,
    sensitivity: "public",
  });
});

afterAll(async () => {
  await redis.quit();
  await withTenantContext(TENANT, async (tx) => {
    await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
    await tx
      .delete(automationExecutions)
      .where(eq(automationExecutions.tenantId, TENANT));
    await tx
      .delete(entityInstances)
      .where(eq(entityInstances.tenantId, TENANT));
  });
});

describe("automation 'assign' action (#191)", () => {
  it("writes assignedTo on the triggering entity via a real automation rule", async () => {
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
      }),
    );

    await createAutomationRule(db, TENANT, {
      name: "Auto-assign on creation",
      triggerType: "entity.created",
      triggerConfig: {},
      actions: [{ type: "assign", config: { assigneeId: "user-abc-123" } }],
    });

    await executeAutomationRules(
      db,
      TENANT,
      {
        version: 1,
        eventType: "entity.created",
        tenantId: TENANT,
        instanceId: instance.id,
        entityTypeId: entityType.id,
        fields: {},
        createdBy: null,
      },
      0,
      redis,
    );

    const updated = await withTenantContext(TENANT, (tx) =>
      getEntity(tx, TENANT, instance.id),
    );
    expect(updated.assignedTo).toBe("user-abc-123");

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
  });
});

describe("automation 'create_entity' action (#191)", () => {
  it("creates a new entity instance via a real automation rule", async () => {
    const trigger = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
      }),
    );

    await createAutomationRule(db, TENANT, {
      name: "Create follow-up on creation",
      triggerType: "entity.created",
      triggerConfig: {},
      conditions: { op: "eq", field: "instanceId", value: trigger.id },
      actions: [
        {
          type: "create_entity",
          config: {
            entityTypeId: entityType.id,
            fields: { title: "Follow-up" },
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
        eventType: "entity.created",
        tenantId: TENANT,
        instanceId: trigger.id,
        entityTypeId: entityType.id,
        fields: {},
        createdBy: null,
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
    const created = after.find((r) => !before.some((b) => b.id === r.id));
    expect(
      (created?.fields as Record<string, unknown> | undefined)?.["title"],
    ).toBe("Follow-up");
  });
});
