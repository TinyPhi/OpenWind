/**
 * Integration tests for cascade-cancel-alerts.ts (docs/specs/ticket-alerts.md
 * §R8), run against a real Postgres instance. Redis/BullMQ is mocked at the
 * service boundary (testing-conventions.md) — this environment's
 * docker-compose deliberately has no host-reachable Redis port.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityInstances,
  entityTypes,
  ticketAlerts,
  withTenantContext,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";

vi.mock("../../src/lib/ticket-alerts-queue.js", () => ({
  ticketAlertsQueue: { remove: vi.fn().mockResolvedValue(undefined) },
  ticketAlertJobId: (id: string) => `alert:${id}`,
}));

const {
  cancelAllPendingAlertsForInstance,
  cancelUsersPendingAlertsForInstance,
} = await import("../../src/lib/cascade-cancel-alerts.js");

const TENANT = "dddddddd-0042-4000-d000-000000000099";
const OWNER = "cascade-owner";
const OTHER = "cascade-other";

let instanceId: string;

async function seedAlert(overrides: Partial<typeof ticketAlerts.$inferInsert>) {
  const [row] = await withTenantContext(TENANT, (tx) =>
    tx
      .insert(ticketAlerts)
      .values({
        tenantId: TENANT,
        instanceId,
        createdBy: OWNER,
        note: "test",
        fireAt: new Date(Date.now() + 3600_000),
        scope: "me",
        ...overrides,
      })
      .returning(),
  );
  return row!;
}

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Isolation Tenant (cascade-cancel)",
    slug: `isolation-cascade-${Date.now()}`,
  });
  const entityType = await createEntityType(db, null, {
    name: `isolation_cascade_ticket_${Date.now()}`,
    plural: "isolation_cascade_tickets",
    allowCustomFields: true,
  });
  const instance = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: OWNER,
  });
  instanceId = instance.id;
});

afterAll(async () => {
  await db.delete(ticketAlerts).where(eq(ticketAlerts.tenantId, TENANT));
  await db.delete(entityInstances).where(eq(entityInstances.tenantId, TENANT));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

describe("cancelAllPendingAlertsForInstance", () => {
  it("cancels every pending alert on the instance, regardless of creator", async () => {
    const a = await seedAlert({ createdBy: OWNER });
    const b = await seedAlert({ createdBy: OTHER });
    const alreadyFired = await seedAlert({
      createdBy: OWNER,
      status: "fired",
      firedAt: new Date(),
    });

    await cancelAllPendingAlertsForInstance(TENANT, instanceId);

    const [rowA] = await withTenantContext(TENANT, (tx) =>
      tx.select().from(ticketAlerts).where(eq(ticketAlerts.id, a.id)),
    );
    const [rowB] = await withTenantContext(TENANT, (tx) =>
      tx.select().from(ticketAlerts).where(eq(ticketAlerts.id, b.id)),
    );
    const [rowFired] = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(ticketAlerts)
        .where(eq(ticketAlerts.id, alreadyFired.id)),
    );

    expect(rowA!.status).toBe("cancelled");
    expect(rowB!.status).toBe("cancelled");
    // Fired alerts are permanent history (§R9) — cascade-cancel must not touch them.
    expect(rowFired!.status).toBe("fired");
  });
});

describe("cancelUsersPendingAlertsForInstance", () => {
  it("cancels only the given user's own pending alerts, leaving others untouched", async () => {
    const mine = await seedAlert({ createdBy: OWNER });
    const theirs = await seedAlert({ createdBy: OTHER });

    await cancelUsersPendingAlertsForInstance(TENANT, instanceId, OWNER);

    const [rowMine] = await withTenantContext(TENANT, (tx) =>
      tx.select().from(ticketAlerts).where(eq(ticketAlerts.id, mine.id)),
    );
    const [rowTheirs] = await withTenantContext(TENANT, (tx) =>
      tx.select().from(ticketAlerts).where(eq(ticketAlerts.id, theirs.id)),
    );

    expect(rowMine!.status).toBe("cancelled");
    expect(rowTheirs!.status).toBe("pending");
  });
});
