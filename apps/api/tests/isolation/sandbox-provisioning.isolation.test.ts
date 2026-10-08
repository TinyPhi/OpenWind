/**
 * Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md T6/T7). Confirms the sandbox
 * tenant row the provisioning job creates (apps/worker/src/sandbox-provisioning-worker.ts)
 * behaves identically to any other tenant under both isolation layers (security.md):
 *
 * 1. A sandbox tenant's own tenant-scoped data is invisible under a different tenant's
 *    withTenantContext -- is_sandbox gets no special-case exemption from RLS.
 * 2. platform_admin_role's quota check (checkSandboxQuota) correctly counts the new row
 *    without needing any column beyond its existing allow-list grant (R2), and the row is
 *    readable through the same PlatformAdminSandboxView shape PR1 already enforces.
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityTypes,
  withTenantContext,
  withPlatformAdminContext,
  checkSandboxQuota,
  toPlatformAdminSandboxView,
  type PlatformAdminSandboxRow,
} from "@platform/db";

const SANDBOX_TENANT = "eeeeeeee-0042-4000-e000-000000000042";
const OTHER_TENANT = "ffffffff-0042-4000-f000-000000000042";
const PLATFORM_ADMIN_USER_ID = `isolation-sandbox-pa-${Date.now()}`;

let sandboxEntityTypeId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: SANDBOX_TENANT,
      name: "Isolation Sandbox Tenant",
      slug: `isolation-sandbox-${Date.now()}`,
      isSandbox: true,
      createdByPlatformAdmin: PLATFORM_ADMIN_USER_ID,
    },
    {
      id: OTHER_TENANT,
      name: "Isolation Other Tenant",
      slug: `isolation-sandbox-other-${Date.now()}`,
    },
  ]);

  const [row] = await db
    .insert(entityTypes)
    .values({
      tenantId: SANDBOX_TENANT,
      name: "sandbox_ticket",
      plural: "sandbox_tickets",
    })
    .returning({ id: entityTypes.id });
  sandboxEntityTypeId = row!.id;
});

afterAll(async () => {
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, SANDBOX_TENANT));
  await db.delete(tenants).where(eq(tenants.id, SANDBOX_TENANT));
  await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT));
});

describe("sandbox tenant isolation", () => {
  it("is visible under its own tenant context", async () => {
    const rows = await withTenantContext(SANDBOX_TENANT, (tx) =>
      tx
        .select({ id: entityTypes.id })
        .from(entityTypes)
        .where(eq(entityTypes.id, sandboxEntityTypeId)),
    );
    expect(rows).toHaveLength(1);
  });

  it("is invisible under a different tenant's context -- is_sandbox gets no RLS exemption", async () => {
    const rows = await withTenantContext(OTHER_TENANT, (tx) =>
      tx
        .select({ id: entityTypes.id })
        .from(entityTypes)
        .where(eq(entityTypes.id, sandboxEntityTypeId)),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("platform_admin visibility of a freshly-provisioned sandbox", () => {
  it("checkSandboxQuota counts the new sandbox for its creating platform_admin", async () => {
    const quota = await withPlatformAdminContext((tx) =>
      checkSandboxQuota(tx, PLATFORM_ADMIN_USER_ID, 10),
    );
    expect(quota.current).toBe(1);
    expect(quota.allowed).toBe(true);
  });

  it("does not count toward a different platform_admin's quota", async () => {
    const quota = await withPlatformAdminContext((tx) =>
      checkSandboxQuota(tx, "some-other-platform-admin", 10),
    );
    expect(quota.current).toBe(0);
  });

  it("is readable through the PlatformAdminSandboxView allow-list shape", async () => {
    const rows = await withPlatformAdminContext((tx) =>
      tx
        .select({
          id: tenants.id,
          name: tenants.name,
          isSandbox: tenants.isSandbox,
          trialEndsAt: tenants.trialEndsAt,
          createdAt: tenants.createdAt,
        })
        .from(tenants)
        .where(eq(tenants.id, SANDBOX_TENANT)),
    );
    const row = rows[0] as PlatformAdminSandboxRow | undefined;
    expect(row).toBeDefined();
    const view = toPlatformAdminSandboxView(row!);
    expect(view).toEqual({
      id: SANDBOX_TENANT,
      name: "Isolation Sandbox Tenant",
      isSandbox: true,
      createdAt: row!.createdAt.toISOString(),
      trialStatus: "none",
    });
  });
});
