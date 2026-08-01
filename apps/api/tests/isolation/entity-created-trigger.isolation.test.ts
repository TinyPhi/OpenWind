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
import Redis from "ioredis";
import {
  db,
  withTenantContext,
  outboxEvents,
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
  TriggerEventSchema,
} from "@platform/automation-engine";

const TENANT = "cccccccc-0000-4000-c000-000000000126";

let entityType: EntityType;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
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
  await redis.quit();
  await withTenantContext(TENANT, async (tx) => {
    await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
    // Without this, re-running this file against a non-fresh local DB
    // accumulates executions from prior runs, making any future assertion on
    // execution count fail confusingly (CI always starts from a fresh DB, so
    // this is a local-debugging footgun rather than a CI risk).
    await tx
      .delete(automationExecutions)
      .where(eq(automationExecutions.tenantId, TENANT));
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

  it("the outbox payload matches automation-engine's TriggerEventSchema exactly", async () => {
    // entity-engine's EntityCreatedEvent (packages/entity-engine/src/types.ts)
    // is a local interface, not imported from automation-engine's
    // EntityCreatedV1Schema, to avoid a dependency cycle — see that file's
    // comment. Nothing else keeps the two in sync: if automation-engine's
    // schema ever gains a new required field, this row would fail
    // TriggerEventSchema.safeParse() in production and every entity.created
    // rule would silently stop firing, exactly the bug #126 fixes. This
    // assertion catches that drift at test time instead.
    await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, { entityTypeId: entityType.id, fields: {} }),
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
    const parsed = TriggerEventSchema.safeParse(row?.payload);
    expect(parsed.success).toBe(true);
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
    await executeAutomationRules(db, TENANT, row?.payload, 0, redis);

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
