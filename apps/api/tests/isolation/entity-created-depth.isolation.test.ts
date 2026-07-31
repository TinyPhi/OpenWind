/**
 * Proves #218's depth-carrying fix on the entity.created path: createEntity
 * stamps depth+1 on the outbox payload when driven by an automation action,
 * and reading that depth back on the next hop correctly trips MAX_DEPTH
 * instead of silently resuming at depth 0.
 *
 * Mirrors entity-assigned-depth.isolation.test.ts (#120) exactly in
 * structure, but for the entity.created event that #218 identified as never
 * having been given the same treatment — buildEntityCreatedPayload had no
 * `depth` parameter at all, so a self-triggering `create_entity` automation
 * rule (see packages/automation-engine/src/actions/create-entity.ts) could
 * recurse without ever tripping MAX_DEPTH.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, withTenantContext, outboxEvents } from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import {
  executeAutomationRules,
  AutomationError,
} from "@platform/automation-engine";

const TENANT = "eeeeeeee-0000-4000-e000-000000000218";

afterAll(async () => {
  await withTenantContext(TENANT, async (tx) => {
    await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
  });
});

describe("entity.created outbox depth carries through for MAX_DEPTH enforcement (#218)", () => {
  it("createEntity stamps depth+1 on the entity.created outbox payload when depth is supplied", async () => {
    const entityType = await createEntityType(db, TENANT, {
      name: `depth_creation_${Date.now()}`,
      plural: "depth_creations",
      allowCustomFields: true,
    });

    // Simulating executeCreateEntityAction (create-entity.ts) driven by an
    // automation rule at recursion depth 9 — this is what a self-triggering
    // `create_entity` rule looks like on the (n)th hop.
    await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
        depth: 9,
      }),
    );

    const [row] = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.tenantId, TENANT),
            eq(outboxEvents.eventType, "entity.created"),
          ),
        ),
    );
    expect(row).toBeDefined();
    expect((row?.payload as Record<string, unknown>).depth).toBe(10);

    // Simulating automation-worker.ts's readDepth(payload) on the next hop:
    // MAX_DEPTH (10) must now trip instead of silently resuming at depth 0.
    const depth = (row?.payload as Record<string, unknown>).depth as number;
    const err = await executeAutomationRules(
      db,
      TENANT,
      row?.payload,
      depth,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AutomationError);
    expect((err as InstanceType<typeof AutomationError>).code).toBe(
      "MAX_DEPTH_EXCEEDED",
    );
  });

  it("createEntity with assignedTo stamps depth+1 on both entity.created and entity.assigned outbox payloads", async () => {
    const entityType = await createEntityType(db, TENANT, {
      name: `depth_assigned_${Date.now()}`,
      plural: "depth_assigneds",
      allowCustomFields: true,
    });

    const TEST_USER = "uuuuuuuu-0000-4000-a000-000000000218";

    const createdInstance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
        assignedTo: TEST_USER,
        depth: 9,
      }),
    );

    const rows = await withTenantContext(TENANT, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.tenantId, TENANT)),
    );

    const createdEvent = rows.find(
      (r) =>
        r.eventType === "entity.created" &&
        (r.payload as Record<string, unknown>).instanceId ===
          createdInstance.id,
    );
    const assignedEvent = rows.find(
      (r) =>
        r.eventType === "entity.assigned" &&
        (r.payload as Record<string, unknown>).instanceId ===
          createdInstance.id,
    );

    expect(createdEvent).toBeDefined();
    expect(assignedEvent).toBeDefined();

    expect((createdEvent?.payload as Record<string, unknown>).depth).toBe(10);
    expect((assignedEvent?.payload as Record<string, unknown>).depth).toBe(10);

    const assignedDepth = (assignedEvent?.payload as Record<string, unknown>)
      .depth as number;
    const err = await executeAutomationRules(
      db,
      TENANT,
      assignedEvent?.payload,
      assignedDepth,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AutomationError);
    expect((err as InstanceType<typeof AutomationError>).code).toBe(
      "MAX_DEPTH_EXCEEDED",
    );
  });
});
