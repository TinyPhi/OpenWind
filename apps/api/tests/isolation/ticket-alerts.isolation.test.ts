/**
 * Tenant isolation tests for the ticket_alerts table (docs/specs/ticket-alerts.md).
 *
 * Two layers, both tested here:
 *  1. Explicit WHERE tenant_id = $tenantId (layer 1 — primary guard).
 *  2. Postgres RLS policy `ticket_alerts_tenant_isolation` (layer 2 — enforced
 *     via SET LOCAL ROLE app_user inside withTenantContext, per #121/#122).
 *
 * ticket_alerts RLS is intentionally tenant-only — no per-user policy. Per-user
 * visibility (creator-always, scope='all' gated on ticket access) is enforced
 * app-side in the alerts routes, not here. See §R2/§V in the spec.
 *
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq, and } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  entityInstances,
  ticketAlerts,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";

const TENANT_A = "aaaaaaaa-0042-4000-a000-000000000042";
const TENANT_B = "bbbbbbbb-0042-4000-b000-000000000042";

let instanceA: string;
let instanceB: string;
let alertAId: string;
let alertBId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Isolation Tenant A (alerts)",
      slug: `isolation-alerts-a-${Date.now()}`,
    },
    {
      id: TENANT_B,
      name: "Isolation Tenant B (alerts)",
      slug: `isolation-alerts-b-${Date.now()}`,
    },
  ]);

  const typeA = await createEntityType(db, null, {
    name: `isolation_alerts_ticket_a_${Date.now()}`,
    plural: "isolation_alerts_tickets_a",
    allowCustomFields: true,
  });
  const typeB = await createEntityType(db, null, {
    name: `isolation_alerts_ticket_b_${Date.now()}`,
    plural: "isolation_alerts_tickets_b",
    allowCustomFields: true,
  });

  const a = await createEntity(db, TENANT_A, {
    entityTypeId: typeA.id,
    fields: {},
    createdBy: "user-a",
  });
  const b = await createEntity(db, TENANT_B, {
    entityTypeId: typeB.id,
    fields: {},
    createdBy: "user-b",
  });
  instanceA = a.id;
  instanceB = b.id;

  // Insert via withTenantContext (SET LOCAL ROLE app_user) — proves the GRANT
  // in migration 0042 is present. Without it every insert here 500s with
  // "permission denied for table ticket_alerts" (the exact #10-class bug
  // 0028/0032 had for access_requests).
  const [rowA] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(ticketAlerts)
      .values({
        tenantId: TENANT_A,
        instanceId: instanceA,
        createdBy: "user-a",
        note: "Tenant A reminder",
        fireAt: new Date(Date.now() + 3600_000),
        scope: "me",
      })
      .returning({ id: ticketAlerts.id }),
  );
  const [rowB] = await withTenantContext(TENANT_B, (tx) =>
    tx
      .insert(ticketAlerts)
      .values({
        tenantId: TENANT_B,
        instanceId: instanceB,
        createdBy: "user-b",
        note: "Tenant B reminder",
        fireAt: new Date(Date.now() + 3600_000),
        scope: "me",
      })
      .returning({ id: ticketAlerts.id }),
  );
  alertAId = rowA!.id;
  alertBId = rowB!.id;
});

afterAll(async () => {
  await db.delete(ticketAlerts).where(eq(ticketAlerts.tenantId, TENANT_A));
  await db.delete(ticketAlerts).where(eq(ticketAlerts.tenantId, TENANT_B));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.tenantId, TENANT_A));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.tenantId, TENANT_B));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

describe("ticket_alerts — app_user GRANT (migration 0042)", () => {
  it("INSERT via withTenantContext succeeds against real Postgres+RLS", () => {
    expect(alertAId).toBeDefined();
    expect(alertBId).toBeDefined();
  });

  it("UPDATE via withTenantContext succeeds (matches GRANT SELECT, INSERT, UPDATE)", async () => {
    const [updated] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .update(ticketAlerts)
        .set({ note: "Updated Tenant A reminder" })
        .where(eq(ticketAlerts.id, alertAId))
        .returning({ note: ticketAlerts.note }),
    );
    expect(updated!.note).toBe("Updated Tenant A reminder");
  });
});

describe("ticket_alerts — cross-tenant READ isolation (layer 1: explicit filter)", () => {
  it("query scoped to Tenant A never returns Tenant B's alert id", async () => {
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ id: ticketAlerts.id })
        .from(ticketAlerts)
        .where(
          and(
            eq(ticketAlerts.id, alertBId),
            eq(ticketAlerts.tenantId, TENANT_A),
          ),
        ),
    );
    expect(rows).toHaveLength(0);
  });

  it("query scoped to Tenant B never returns Tenant A's alert id", async () => {
    const rows = await withTenantContext(TENANT_B, (tx) =>
      tx
        .select({ id: ticketAlerts.id })
        .from(ticketAlerts)
        .where(
          and(
            eq(ticketAlerts.id, alertAId),
            eq(ticketAlerts.tenantId, TENANT_B),
          ),
        ),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("ticket_alerts — RLS enforcement independent of explicit filter (layer 2)", () => {
  it("a query with the app.tenant_id GUC set to Tenant A returns 0 rows for Tenant B's alert, even with no WHERE tenant_id clause", async () => {
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM ticket_alerts WHERE id = ${alertBId}`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it("a query with the app.tenant_id GUC set to Tenant B returns 0 rows for Tenant A's alert, even with no WHERE tenant_id clause", async () => {
    const rows = await withTenantContext(TENANT_B, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM ticket_alerts WHERE id = ${alertAId}`,
      ),
    );
    expect(rows).toHaveLength(0);
  });
});
