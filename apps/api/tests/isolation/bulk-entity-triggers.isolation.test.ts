/**
 * Proves #126's outbox emission (entity.created/entity.assigned) works
 * correctly on the bulk code paths too, not just the single-entity ones
 * already covered by entity-created-trigger.isolation.test.ts and
 * entity-assigned-trigger.isolation.test.ts. bulkCreateEntities and
 * bulkUpdateEntities have distinct code (a per-type sensitivity cache and a
 * single batched insert for create; per-item Promise.all collection then one
 * batched insert for update) that the mock-based unit tests in bulk.test.ts
 * only check by call count, not by payload shape or actual queryability.
 */

import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, withTenantContext, outboxEvents } from "@platform/db";
import {
  createEntityType,
  addEntityField,
  bulkCreateEntities,
  bulkUpdateEntities,
} from "@platform/entity-engine";

const TENANT = "dddddddd-0000-4000-d000-000000000126";
const ASSIGNEE_ID = "11111111-0000-4000-a000-000000000002";

describe("bulkCreateEntities outbox emission (#126)", () => {
  it("writes one entity.created row per created entity, with pii fields redacted", async () => {
    const entityType = await createEntityType(db, TENANT, {
      name: `bulk_create_ticket_${Date.now()}`,
      plural: "bulk_create_tickets",
      allowCustomFields: true,
    });
    await addEntityField(db, TENANT, entityType.id, {
      name: "ssn",
      label: "SSN",
      fieldType: "text",
      config: {},
      isRequired: false,
      isIndexed: false,
      isSystem: false,
      sortOrder: 0,
      sensitivity: "pii",
    });

    const { created, errors } = await withTenantContext(TENANT, (tx) =>
      bulkCreateEntities(tx, TENANT, [
        { entityTypeId: entityType.id, fields: { ssn: "111-11-1111" } },
        { entityTypeId: entityType.id, fields: { ssn: "222-22-2222" } },
      ]),
    );
    expect(errors).toHaveLength(0);
    expect(created).toHaveLength(2);

    const rows = await withTenantContext(TENANT, (tx) =>
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
    const forThisBatch = rows.filter((r) =>
      created.some(
        (c) => c.id === (r.payload as Record<string, unknown>).instanceId,
      ),
    );
    expect(forThisBatch).toHaveLength(2);
    for (const row of forThisBatch) {
      const fields = (row.payload as Record<string, unknown>).fields as Record<
        string,
        unknown
      >;
      expect(fields["ssn"]).toBe("[REDACTED]");
    }
    expect(JSON.stringify(forThisBatch)).not.toContain("111-11-1111");
    expect(JSON.stringify(forThisBatch)).not.toContain("222-22-2222");

    await withTenantContext(TENANT, async (tx) => {
      await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
    });
  });
});

describe("bulkUpdateEntities outbox emission (#126)", () => {
  it("fires entity.assigned only for items whose assignee actually changed", async () => {
    const entityType = await createEntityType(db, TENANT, {
      name: `bulk_update_ticket_${Date.now()}`,
      plural: "bulk_update_tickets",
      allowCustomFields: true,
    });

    const { created } = await withTenantContext(TENANT, (tx) =>
      bulkCreateEntities(tx, TENANT, [
        { entityTypeId: entityType.id, fields: {}, assignedTo: ASSIGNEE_ID },
        { entityTypeId: entityType.id, fields: {} },
      ]),
    );
    const [alreadyAssigned, unassigned] = created;

    await withTenantContext(TENANT, async (tx) => {
      await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
    });

    const { updated, errors } = await withTenantContext(TENANT, (tx) =>
      bulkUpdateEntities(tx, TENANT, [
        // Same assignee as before — must NOT fire entity.assigned.
        { id: alreadyAssigned!.id, input: { assignedTo: ASSIGNEE_ID } },
        // New assignee — must fire entity.assigned.
        { id: unassigned!.id, input: { assignedTo: ASSIGNEE_ID } },
      ]),
    );
    expect(errors).toHaveLength(0);
    expect(updated).toHaveLength(2);

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
    expect(rows).toHaveLength(1);
    expect((rows[0]?.payload as Record<string, unknown>).instanceId).toBe(
      unassigned!.id,
    );

    await withTenantContext(TENANT, async (tx) => {
      await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
    });
  });
});
