/**
 * Proves #126 is fixed: entity.created actually reaches the outbox and
 * drives real automation execution end-to-end.
 *
 * Before the fix, createEntity never wrote to outbox_events at all, so any
 * automation rule with trigger_type = 'entity.created' (e.g. the helpdesk
 * module's "auto-set priority" seed rule) silently never fired. This mirrors
 * that exact seed rule shape. Also proves the PII/financial redaction fix
 * found during review — see entity-assigned-trigger.isolation.test.ts for
 * the entity.assigned half of #126.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, desc } from "drizzle-orm";
import { db, withTenantContext, outboxEvents } from "@platform/db";
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

const TENANT = "cccccccc-0000-4000-c000-000000000126";

let entityType: EntityType;

beforeAll(async () => {
  entityType = await createEntityType(db, TENANT, {
    name: `trigger_ticket_${Date.now()}`,
    plural: "trigger_tickets",
    allowCustomFields: true,
  });

  await addEntityField(db, TENANT, entityType.id, {
    name: "priority",
    label: "Priority",
    fieldType: "text",
    config: {},
    isRequired: false,
    isIndexed: false,
    isSystem: false,
    sortOrder: 0,
    sensitivity: "public",
  });

  await addEntityField(db, TENANT, entityType.id, {
    name: "ssn",
    label: "SSN",
    fieldType: "text",
    config: {},
    isRequired: false,
    isIndexed: false,
    isSystem: false,
    sortOrder: 1,
    sensitivity: "pii",
  });

  // Mirrors modules/helpdesk/seed/003_automation_rules.sql exactly.
  await createAutomationRule(db, TENANT, {
    name: "Auto-set default priority on ticket creation",
    triggerType: "entity.created",
    triggerConfig: { entityType: entityType.name },
    actions: [
      { type: "set_field", config: { field: "priority", value: "medium" } },
    ],
  });
});

afterAll(async () => {
  await withTenantContext(TENANT, async (tx) => {
    await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
  });
});

describe("entity.created outbox emission and automation execution (#126)", () => {
  it("createEntity writes an entity.created row to the outbox", async () => {
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
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
        )
        .orderBy(desc(outboxEvents.createdAt))
        .limit(1),
    );

    expect(row).toBeDefined();
    const payload = row?.payload as Record<string, unknown>;
    expect(payload.instanceId).toBe(instance.id);
    expect(payload.entityTypeId).toBe(entityType.id);
    expect(payload.version).toBe(1);
  });

  it("the seeded set_field rule actually fires when the outbox event is processed", async () => {
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
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
        )
        .orderBy(desc(outboxEvents.createdAt))
        .limit(1),
    );

    expect(row).toBeDefined();

    // Simulates what apps/worker/src/outbox-poller.ts does: hand the exact
    // stored payload to the executor, unmodified.
    await executeAutomationRules(db, TENANT, row?.payload);

    const updated = await getEntity(db, TENANT, instance.id);
    expect(updated.fields["priority"]).toBe("medium");
  });

  it("redacts pii-classified field values in the outbox payload", async () => {
    await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: { ssn: "123-45-6789" },
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
        )
        .orderBy(desc(outboxEvents.createdAt))
        .limit(1),
    );

    expect(row).toBeDefined();
    const payload = row?.payload as Record<string, unknown>;
    const fields = payload.fields as Record<string, unknown>;
    expect(fields["ssn"]).toBe("[REDACTED]");
    // The raw SSN value must never appear anywhere in the stored row.
    expect(JSON.stringify(payload)).not.toContain("123-45-6789");
  });
});
