/**
 * T14 (docs/specs/multi-org-sandbox.md) -- confirms tenant-purge.ts actually clears a
 * purged sandbox's handover credentials from Redis, rather than leaving them retrievable
 * for the remainder of their 7-day TTL. R8's "delete this org's data" means now.
 *
 * Real Postgres and real Redis (only BullMQ mocked, same convention as
 * tenant-purge.isolation.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, tenants } from "@platform/db";
import {
  storeSandboxHandoverCredentials,
  getSandboxHandoverCredentials,
} from "@platform/auth";

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

const TENANT_ID = "eeeeeeee-0140-4000-e000-000000000140";

beforeAll(async () => {
  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: "T14 sandbox-handover purge regression tenant",
      slug: `t14-handover-purge-${Date.now()}`,
      isSandbox: true,
      status: "deleted",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

describe("tenant-purge: sandbox handover credentials (T14)", () => {
  it("deletes the sandbox's handover credentials from Redis as part of the purge", async () => {
    await storeSandboxHandoverCredentials(TENANT_ID, {
      seededAccounts: [{ email: "admin@example.com", role: "admin" }],
      defaultPassword: "Ow-abc-9!",
    });
    expect(await getSandboxHandoverCredentials(TENANT_ID)).not.toBeNull();

    await import("../../src/tenant-purge.js");
    if (!capturedProcessor) throw new Error("purge processor was not captured");
    await capturedProcessor({
      id: `job-${TENANT_ID}`,
      data: { tenantId: TENANT_ID },
    });

    expect(await getSandboxHandoverCredentials(TENANT_ID)).toBeNull();
  }, 30_000);
});
