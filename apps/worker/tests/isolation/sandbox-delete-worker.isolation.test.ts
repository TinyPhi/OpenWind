/**
 * T15 (docs/specs/multi-org-sandbox.md) -- confirms processSandboxDeleteJob flips a real
 * sandbox tenant's status to 'deleted' with a near-immediate deletionScheduledAt (not the
 * real-tenant 30-day default), and enqueues the existing tenant-purge queue with delay: 0
 * for that tenant.
 *
 * Real Postgres and real Redis. Only two things are mocked, both for reasons that have
 * nothing to do with database isolation: @platform/auth's deleteOrg (a real network call to
 * Zitadel has no place in a test) and the tenant-purge queue's own `add` (this test asserts
 * the enqueue call was made correctly; it does not need a real tenant-purge worker to
 * actually run against this tenant, which sandbox-reset-wipe-scope.isolation.test.ts's
 * sibling precedent (processSandboxResetJob) establishes is the right split of
 * responsibility between a unit-style assertion and the already-covered real purge flow in
 * tenant-purge.isolation.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, tenants } from "@platform/db";
import type * as PlatformAuth from "@platform/auth";
import type * as Queues from "../../src/queues.js";

const mockDeleteOrg = vi.fn().mockResolvedValue(true);
vi.mock("@platform/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformAuth>();
  return {
    ...actual,
    deleteOrg: (...args: unknown[]) => mockDeleteOrg(...args),
  };
});

const mockTenantPurgeQueueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/queues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Queues>();
  return {
    ...actual,
    tenantPurgeQueue: {
      add: (...args: unknown[]) => mockTenantPurgeQueueAdd(...args),
    },
  };
});

const TENANT_ID = "eeeeeeee-0170-4000-e000-000000000170";

beforeAll(async () => {
  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: "T15 sandbox-delete regression tenant",
      slug: `t15-delete-${Date.now()}`,
      isSandbox: true,
      status: "active",
      zitadelOrgId: "org-t15-regression",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

describe("sandbox delete: status flip + immediate purge enqueue (T15)", () => {
  it("deletes the Zitadel org, flips the tenant to 'deleted' with deletionScheduledAt ~= now, and enqueues an immediate tenant-purge job", async () => {
    const { processSandboxDeleteJob } =
      await import("../../src/sandbox-delete-worker.js");
    const before = Date.now();

    await processSandboxDeleteJob({
      id: "t15-delete-job",
      data: { tenantId: TENANT_ID, requestedBy: "admin-1" },
    });

    expect(mockDeleteOrg).toHaveBeenCalledWith("org-t15-regression");

    const [tenantRow] = await db
      .select({
        status: tenants.status,
        deletionScheduledAt: tenants.deletionScheduledAt,
      })
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID))
      .limit(1);
    expect(tenantRow?.status).toBe("deleted");
    expect(tenantRow?.deletionScheduledAt).not.toBeNull();
    expect(tenantRow!.deletionScheduledAt!.getTime() - before).toBeLessThan(
      5_000,
    );

    expect(mockTenantPurgeQueueAdd).toHaveBeenCalledWith(
      "purge",
      { tenantId: TENANT_ID },
      expect.objectContaining({ delay: 0, jobId: `tenant-purge-${TENANT_ID}` }),
    );
  }, 30_000);
});
