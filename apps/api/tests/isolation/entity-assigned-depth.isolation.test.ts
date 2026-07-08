/**
 * Proves #120's depth-carrying fix on the entity.assigned path: updateEntity
 * stamps depth+1 on the outbox payload when driven by an automation action,
 * and reading that depth back on the next hop correctly trips MAX_DEPTH
 * instead of silently resuming at depth 0.
 *
 * No current automation action can actually reach this path today — set_field
 * only ever touches `fields`, never `assignedTo` (there's no implemented
 * `assign` action yet) — so this exercises the plumbing directly rather than
 * through a real rule chain. See automation-depth-recursion.isolation.test.ts
 * for #120's other half (the transition double-trigger fix), which *is* live.
 */

import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, withTenantContext, outboxEvents } from "@platform/db";
import {
  createEntityType,
  createEntity,
  updateEntity,
} from "@platform/entity-engine";
import {
  executeAutomationRules,
  AutomationError,
} from "@platform/automation-engine";

const TENANT = "eeeeeeee-0000-4000-e000-000000000120";

describe("entity.assigned outbox depth carries through for MAX_DEPTH enforcement (#120)", () => {
  it("updateEntity stamps depth+1 on the entity.assigned outbox payload when depth is supplied", async () => {
    const entityType = await createEntityType(db, TENANT, {
      name: `depth_assignee_${Date.now()}`,
      plural: "depth_assignees",
      allowCustomFields: true,
    });

    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, { entityTypeId: entityType.id, fields: {} }),
    );

    // No current automation action can reach this path (set_field only
    // touches `fields`, never `assignedTo`) — this simulates what a future
    // assign-capable action would do, exercising the plumbing directly.
    await withTenantContext(TENANT, (tx) =>
      updateEntity(tx, TENANT, instance.id, {
        assignedTo: "11111111-0000-4000-a000-000000000001",
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
            eq(outboxEvents.eventType, "entity.assigned"),
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

    await withTenantContext(TENANT, async (tx) => {
      await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
    });
  });
});
