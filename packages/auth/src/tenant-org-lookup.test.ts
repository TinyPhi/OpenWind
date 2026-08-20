import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, tenants } from "@platform/db";
import { lookupTenantIdByOrgId, lookupOrgIdByTenantId } from "./middleware.js";

// Real database, not mocked — per testing-conventions.md's real-implementation
// preference, and because this proves the actual requirement (R5): a second
// org+tenant mapping resolves correctly from data alone, no code change.
// See docs/specs/tenant-org-id-mapping.md.

const ORG_A = "test-zitadel-org-aaaa";
const ORG_B = "test-zitadel-org-bbbb";
const TENANT_A = "aaaaaaaa-1111-4000-a000-000000000091";
const TENANT_B = "bbbbbbbb-1111-4000-b000-000000000092";

describe("lookupTenantIdByOrgId", () => {
  // Mirrors afterAll — a crashed prior run leaves these rows behind, which
  // would PK-violate the insert below before any assertion ran.
  beforeAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, TENANT_A));
    await db.delete(tenants).where(eq(tenants.id, TENANT_B));
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, TENANT_A));
    await db.delete(tenants).where(eq(tenants.id, TENANT_B));
  });

  it("resolves each mapped org to its own distinct tenant", async () => {
    await db.insert(tenants).values([
      {
        id: TENANT_A,
        name: "Org A Co",
        slug: `org-a-${TENANT_A}`,
        zitadelOrgId: ORG_A,
      },
      {
        id: TENANT_B,
        name: "Org B Co",
        slug: `org-b-${TENANT_B}`,
        zitadelOrgId: ORG_B,
      },
    ]);

    const resolvedA = await lookupTenantIdByOrgId(ORG_A);
    const resolvedB = await lookupTenantIdByOrgId(ORG_B);

    expect(resolvedA).toBe(TENANT_A);
    expect(resolvedB).toBe(TENANT_B);
    expect(resolvedA).not.toBe(resolvedB);
  });

  it("returns null for an org with no mapped tenant", async () => {
    const resolved = await lookupTenantIdByOrgId("no-such-org-ever");
    expect(resolved).toBeNull();
  });

  it("resolves each tenant to its own distinct org", async () => {
    const resolvedA = await lookupOrgIdByTenantId(TENANT_A);
    const resolvedB = await lookupOrgIdByTenantId(TENANT_B);

    expect(resolvedA).toBe(ORG_A);
    expect(resolvedB).toBe(ORG_B);
  });

  it("returns null for a tenant with no mapped org", async () => {
    const resolved = await lookupOrgIdByTenantId(
      "00000000-0000-4000-a000-000000000000",
    );
    expect(resolved).toBeNull();
  });
});
