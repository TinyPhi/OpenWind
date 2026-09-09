/**
 * Tenant isolation tests for the services table.
 *
 * docs/specs/oncall-routing.md T2, R4, R12 -- 3E on-call routing, Phase 1.
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db, withTenantContext, services, tenants } from "@platform/db";

const TENANT_A = "aaaaaaaa-4444-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-4444-4000-b000-000000000002";
const USER_A = "aaaaaaaa-4444-4000-a000-000000000900";
const USER_B = "bbbbbbbb-4444-4000-b000-000000000900";

let serviceAId: string;
let serviceBId: string;

beforeAll(async () => {
  // services.tenant_id REFERENCES tenants(id) -- real tenant rows required.
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Services Isolation Test A",
      slug: `services-isolation-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Services Isolation Test B",
      slug: `services-isolation-b-${TENANT_B}`,
    },
  ]);
  const [serviceA] = await db
    .insert(services)
    .values({ tenantId: TENANT_A, name: "Payments API", createdBy: USER_A })
    .returning({ id: services.id });
  const [serviceB] = await db
    .insert(services)
    .values({ tenantId: TENANT_B, name: "Payments API", createdBy: USER_B })
    .returning({ id: services.id });
  serviceAId = serviceA!.id;
  serviceBId = serviceB!.id;
});

afterAll(async () => {
  await db.delete(services).where(eq(services.tenantId, TENANT_A));
  await db.delete(services).where(eq(services.tenantId, TENANT_B));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("services — cross-tenant READ isolation", () => {
  it("Tenant A's read scoped to Tenant A does not return Tenant B's service", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: services.id })
        .from(services)
        .where(
          and(eq(services.id, serviceBId), eq(services.tenantId, TENANT_A)),
        );
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A can read its own service", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: services.id })
        .from(services)
        .where(eq(services.tenantId, TENANT_A));
      expect(rows.map((r) => r.id)).toContain(serviceAId);
    });
  });

  it("RLS blocks a raw cross-tenant SELECT under app_user role", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
      );
      return tx
        .select({ id: services.id })
        .from(services)
        .where(eq(services.id, serviceBId));
    });
    expect(rows).toHaveLength(0);
  });
});

describe("services — cross-tenant WRITE isolation", () => {
  it("RLS blocks inserting a row tagged with a different tenant_id under app_user role", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx.insert(services).values({
          tenantId: TENANT_B,
          name: "Smuggled Service",
          createdBy: USER_A,
        });
      }),
    ).rejects.toBeTruthy();
  });
});
