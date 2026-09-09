/**
 * Tenant isolation tests for the labels table.
 *
 * docs/specs/oncall-routing.md T34, R1b, R12 -- 3E on-call routing, Phase 1.
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db, withTenantContext, labels, tenants } from "@platform/db";

const TENANT_A = "aaaaaaaa-6666-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-6666-4000-b000-000000000002";
const USER_A = "aaaaaaaa-6666-4000-a000-000000000900";
const USER_B = "bbbbbbbb-6666-4000-b000-000000000900";

let labelAId: string;
let labelBId: string;

beforeAll(async () => {
  // labels.tenant_id REFERENCES tenants(id) -- real tenant rows required.
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Labels Isolation Test A",
      slug: `labels-isolation-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Labels Isolation Test B",
      slug: `labels-isolation-b-${TENANT_B}`,
    },
  ]);
  const [labelA] = await db
    .insert(labels)
    .values({
      tenantId: TENANT_A,
      name: "urgent",
      color: "#e11d48",
      createdBy: USER_A,
    })
    .returning({ id: labels.id });
  const [labelB] = await db
    .insert(labels)
    .values({
      tenantId: TENANT_B,
      name: "urgent",
      color: "#e11d48",
      createdBy: USER_B,
    })
    .returning({ id: labels.id });
  labelAId = labelA!.id;
  labelBId = labelB!.id;
});

afterAll(async () => {
  await db.delete(labels).where(eq(labels.tenantId, TENANT_A));
  await db.delete(labels).where(eq(labels.tenantId, TENANT_B));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("labels — cross-tenant READ isolation", () => {
  it("Tenant A's read scoped to Tenant A does not return Tenant B's label", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.id, labelBId), eq(labels.tenantId, TENANT_A)));
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A can read its own label", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: labels.id })
        .from(labels)
        .where(eq(labels.tenantId, TENANT_A));
      expect(rows.map((r) => r.id)).toContain(labelAId);
    });
  });

  it("RLS blocks a raw cross-tenant SELECT under app_user role", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
      );
      return tx
        .select({ id: labels.id })
        .from(labels)
        .where(eq(labels.id, labelBId));
    });
    expect(rows).toHaveLength(0);
  });
});

describe("labels — cross-tenant WRITE isolation", () => {
  it("RLS blocks inserting a row tagged with a different tenant_id under app_user role", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx.insert(labels).values({
          tenantId: TENANT_B,
          name: "smuggled",
          color: "#000000",
          createdBy: USER_A,
        });
      }),
    ).rejects.toBeTruthy();
  });
});
