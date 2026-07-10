/**
 * Proves #126 is fixed: entity.assigned actually reaches the outbox, both
 * on create-with-assignee and on reassignment via update, and that
 * reassigning to the same assignee doesn't re-fire it. See
 * entity-created-trigger.isolation.test.ts for the entity.created half.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, desc } from "drizzle-orm";
import { db, withTenantContext, outboxEvents } from "@platform/db";
import {
  createEntityType,
  createEntity,
  updateEntity,
} from "@platform/entity-engine";
import type { EntityType } from "@platform/entity-engine";

const TENANT = "eeeeeeee-0000-4000-e000-000000000126";
const ASSIGNEE_ID = "dddddddd-0000-4000-d000-000000000001";

let entityType: EntityType;

beforeAll(async () => {
  entityType = await createEntityType(db, TENANT, {
    name: `assign_ticket_${Date.now()}`,
    plural: "assign_tickets",
    allowCustomFields: true,
  });
});

afterAll(async () => {
  await withTenantContext(TENANT, async (tx) => {
    await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
  });
});

describe("entity.assigned outbox emission (#126)", () => {
  it("createEntity with an assignee writes an entity.assigned row to the outbox", async () => {
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
        assignedTo: ASSIGNEE_ID,
      }),
    );

    const [row] = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.tenantId, TENANT),
            eq(outboxEvents.eventType, "entity.assigned"),
          ),
        )
        .orderBy(desc(outboxEvents.createdAt))
        .limit(1),
    );

    expect(row).toBeDefined();
    const payload = row?.payload as Record<string, unknown>;
    expect(payload.instanceId).toBe(instance.id);
    expect(payload.assigneeId).toBe(ASSIGNEE_ID);
  });

  it("updateEntity reassignment writes an entity.assigned row to the outbox", async () => {
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
      }),
    );

    await withTenantContext(TENANT, (tx) =>
      updateEntity(tx, TENANT, instance.id, { assignedTo: ASSIGNEE_ID }),
    );

    const [row] = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.tenantId, TENANT),
            eq(outboxEvents.eventType, "entity.assigned"),
          ),
        )
        .orderBy(desc(outboxEvents.createdAt))
        .limit(1),
    );

    expect(row).toBeDefined();
    const payload = row?.payload as Record<string, unknown>;
    expect(payload.instanceId).toBe(instance.id);
    expect(payload.assigneeId).toBe(ASSIGNEE_ID);
  });

  it("updateEntity reassignment to the same assignee does not re-fire entity.assigned", async () => {
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
        assignedTo: ASSIGNEE_ID,
      }),
    );

    await withTenantContext(TENANT, (tx) =>
      updateEntity(tx, TENANT, instance.id, { assignedTo: ASSIGNEE_ID }),
    );

    const rows = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.tenantId, TENANT),
            eq(outboxEvents.eventType, "entity.assigned"),
          ),
        ),
    );

    // Exactly one: from create-with-assignee. The no-op update must not add a second.
    const forThisInstance = rows.filter(
      (r) => (r.payload as Record<string, unknown>).instanceId === instance.id,
    );
    expect(forThisInstance).toHaveLength(1);
  });
});
