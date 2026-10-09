/**
 * Review finding, PR #828 -- a transient failure in either of tenant-purge.ts's two
 * best-effort, post-transaction cleanup steps (on-disk file deletion, sandbox handover
 * Redis key deletion) must not fail the whole purge job: the DB transaction and the
 * purge.completed audit entry have already committed successfully by that point, so an
 * unhandled throw here would misrepresent a genuinely successful purge as a failed job.
 *
 * Real Postgres (no mocks on @platform/db, matching the isolation-test convention); only
 * @platform/files and @platform/auth's handover-delete function are mocked, specifically
 * to force the failure this test exists to guard against.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, tenants } from "@platform/db";
import type * as PlatformAuth from "@platform/auth";

let capturedProcessor: ((job: unknown) => Promise<void>) | null = null;

vi.mock("bullmq", () => ({
  Queue: vi.fn(),
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: (job: unknown) => Promise<void>,
  ) {
    capturedProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
}));

vi.mock("../../src/queues.js", () => ({ connection: {} }));

const mockDeleteTenantFiles = vi
  .fn()
  .mockRejectedValue(new Error("disk unavailable"));
vi.mock("@platform/files", () => ({
  deleteTenantFiles: (...args: unknown[]) => mockDeleteTenantFiles(...args),
}));

const mockDeleteSandboxHandoverCredentials = vi
  .fn()
  .mockRejectedValue(new Error("redis unavailable"));
vi.mock("@platform/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformAuth>();
  return {
    ...actual,
    deleteSandboxHandoverCredentials: (...args: unknown[]) =>
      mockDeleteSandboxHandoverCredentials(...args),
  };
});

const TENANT_ID = "eeeeeeee-0141-4000-e000-000000000141";

beforeAll(async () => {
  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: "PR828 best-effort resilience regression tenant",
      slug: `pr828-resilience-${Date.now()}`,
      status: "deleted",
    })
    .onConflictDoNothing();

  await import("../../src/tenant-purge.js");
});

afterAll(async () => {
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

describe("tenant-purge: best-effort cleanup resilience (review finding, PR #828)", () => {
  it("completes the purge job and marks the tenant purged even when both post-transaction cleanup calls fail", async () => {
    if (!capturedProcessor) throw new Error("purge processor was not captured");

    await expect(
      capturedProcessor({
        id: `job-${TENANT_ID}`,
        attemptsMade: 1,
        opts: { attempts: 1 },
        data: { tenantId: TENANT_ID },
      }),
    ).resolves.toBeUndefined();

    expect(mockDeleteTenantFiles).toHaveBeenCalledWith(TENANT_ID);
    expect(mockDeleteSandboxHandoverCredentials).toHaveBeenCalledWith(
      TENANT_ID,
    );

    const [tenantRow] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID))
      .limit(1);
    expect(tenantRow?.status).toBe("purged");
  }, 30_000);
});
