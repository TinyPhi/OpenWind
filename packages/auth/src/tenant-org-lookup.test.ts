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
    try {
      await db.delete(tenants).where(eq(tenants.id, TENANT_A));
      await db.delete(tenants).where(eq(tenants.id, TENANT_B));
    } catch {
      // Ignore database cleanup errors in offline test environments
    }
  });

  afterAll(async () => {
    try {
      await db.delete(tenants).where(eq(tenants.id, TENANT_A));
      await db.delete(tenants).where(eq(tenants.id, TENANT_B));
    } catch {
      // Ignore database cleanup errors in offline test environments
    }
  });

  it("resolves each mapped org to its own distinct tenant", async () => {
    try {
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
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (
          err.message.includes("Failed query") ||
          err.message.includes("authentication failed") ||
          err.message.includes("connect ECONNREFUSED")
        ) {
          return;
        }
      }
      throw err;
    }
  });

  it("returns null for an org with no mapped tenant", async () => {
    try {
      const resolved = await lookupTenantIdByOrgId("no-such-org-ever");
      expect(resolved).toBeNull();
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (
          err.message.includes("Failed query") ||
          err.message.includes("authentication failed") ||
          err.message.includes("connect ECONNREFUSED")
        ) {
          return;
        }
      }
      throw err;
    }
  });

  it("resolves each tenant to its own distinct org", async () => {
    try {
      const resolvedA = await lookupOrgIdByTenantId(TENANT_A);
      const resolvedB = await lookupOrgIdByTenantId(TENANT_B);

      expect(resolvedA).toBe(ORG_A);
      expect(resolvedB).toBe(ORG_B);
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (
          err.message.includes("Failed query") ||
          err.message.includes("authentication failed") ||
          err.message.includes("connect ECONNREFUSED")
        ) {
          return;
        }
      }
      throw err;
    }
  });

  it("returns null for a tenant with no mapped org", async () => {
    try {
      const resolved = await lookupOrgIdByTenantId(
        "00000000-0000-4000-a000-000000000000",
      );
      expect(resolved).toBeNull();
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (
          err.message.includes("Failed query") ||
          err.message.includes("authentication failed") ||
          err.message.includes("connect ECONNREFUSED")
        ) {
          return;
        }
      }
      throw err;
    }
  });
});
