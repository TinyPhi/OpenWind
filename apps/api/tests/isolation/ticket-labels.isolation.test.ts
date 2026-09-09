/**
 * Tenant isolation tests for the ticket_labels junction table.
 *
 * docs/specs/oncall-routing.md T35, R1c, R12 -- 3E on-call routing, Phase 1.
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  db,
  withTenantContext,
  labels,
  ticketLabels,
  entityTypes,
  entityInstances,
  tenants,
} from "@platform/db";

const TENANT_A = "aaaaaaaa-7777-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-7777-4000-b000-000000000002";
const USER_A = "aaaaaaaa-7777-4000-a000-000000000900";
const USER_B = "bbbbbbbb-7777-4000-b000-000000000900";

let entityTypeId: string;
let ticketAId: string;
let ticketBId: string;
let labelAId: string;
let labelBId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Ticket Labels Isolation Test A",
      slug: `ticket-labels-isolation-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Ticket Labels Isolation Test B",
      slug: `ticket-labels-isolation-b-${TENANT_B}`,
    },
  ]);

  const [entityType] = await db
    .insert(entityTypes)
    .values({ name: `ticket-labels-test-${TENANT_A}`, plural: "Tickets" })
    .returning({ id: entityTypes.id });
  entityTypeId = entityType!.id;

  const [ticketA] = await db
    .insert(entityInstances)
    .values({ entityTypeId, tenantId: TENANT_A })
    .returning({ id: entityInstances.id });
  const [ticketB] = await db
    .insert(entityInstances)
    .values({ entityTypeId, tenantId: TENANT_B })
    .returning({ id: entityInstances.id });
  ticketAId = ticketA!.id;
  ticketBId = ticketB!.id;

  const [labelA] = await db
    .insert(labels)
    .values({
      tenantId: TENANT_A,
      name: "bug",
      color: "#e11d48",
      createdBy: USER_A,
    })
    .returning({ id: labels.id });
  const [labelB] = await db
    .insert(labels)
    .values({
      tenantId: TENANT_B,
      name: "bug",
      color: "#e11d48",
      createdBy: USER_B,
    })
    .returning({ id: labels.id });
  labelAId = labelA!.id;
  labelBId = labelB!.id;

  await db.insert(ticketLabels).values([
    {
      ticketInstanceId: ticketAId,
      labelId: labelAId,
      tenantId: TENANT_A,
      assignedBy: USER_A,
    },
    {
      ticketInstanceId: ticketBId,
      labelId: labelBId,
      tenantId: TENANT_B,
      assignedBy: USER_B,
    },
  ]);
});

afterAll(async () => {
  await db.delete(ticketLabels).where(eq(ticketLabels.tenantId, TENANT_A));
  await db.delete(ticketLabels).where(eq(ticketLabels.tenantId, TENANT_B));
  await db.delete(labels).where(eq(labels.tenantId, TENANT_A));
  await db.delete(labels).where(eq(labels.tenantId, TENANT_B));
  await db
    .delete(entityInstances)
    .where(inArray(entityInstances.id, [ticketAId, ticketBId]));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("ticket_labels — cross-tenant READ isolation", () => {
  it("Tenant A's read scoped to Tenant A does not return Tenant B's ticket_labels row", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ ticketInstanceId: ticketLabels.ticketInstanceId })
        .from(ticketLabels)
        .where(
          and(
            eq(ticketLabels.ticketInstanceId, ticketBId),
            eq(ticketLabels.tenantId, TENANT_A),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A can read its own ticket_labels row", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ ticketInstanceId: ticketLabels.ticketInstanceId })
        .from(ticketLabels)
        .where(eq(ticketLabels.tenantId, TENANT_A));
      expect(rows.map((r) => r.ticketInstanceId)).toContain(ticketAId);
    });
  });

  it("RLS blocks a raw cross-tenant SELECT under app_user role", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
      );
      return tx
        .select({ ticketInstanceId: ticketLabels.ticketInstanceId })
        .from(ticketLabels)
        .where(eq(ticketLabels.ticketInstanceId, ticketBId));
    });
    expect(rows).toHaveLength(0);
  });
});

describe("ticket_labels — cross-tenant WRITE isolation", () => {
  it("RLS blocks inserting a row tagged with a different tenant_id under app_user role", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx.insert(ticketLabels).values({
          ticketInstanceId: ticketAId,
          labelId: labelBId,
          tenantId: TENANT_B,
          assignedBy: USER_A,
        });
      }),
    ).rejects.toBeTruthy();
  });
});
