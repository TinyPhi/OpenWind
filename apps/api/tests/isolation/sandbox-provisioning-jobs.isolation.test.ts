/**
 * Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md T8/T21, migration 0137).
 * `sandbox_provisioning_jobs` is platform-level, not tenant-scoped (no RLS, no `tenant_id`
 * column by design -- see the migration's own comment for why it's `result_tenant_id`
 * instead). This table holds only progress-tracking metadata, no credentials (the T21
 * handover artifact lives in Redis instead, security review -- see
 * packages/auth/src/sandbox-handover-store.ts), so `platform_admin_role` gets a blanket
 * SELECT on every column here -- this test confirms that grant actually works end to end,
 * and that the table is unreachable under the plain `app_user` role the same way every
 * other platform-only table is.
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  db,
  sandboxProvisioningJobs,
  withPlatformAdminContext,
} from "@platform/db";

const JOB_ID = "11111111-0136-4000-a000-000000000136";

beforeAll(async () => {
  await db.insert(sandboxProvisioningJobs).values({
    id: JOB_ID,
    requestedBy: "isolation-test-platform-admin",
    orgName: "Isolation Test Sandbox",
    status: "completed",
    currentStep: null,
    completedSteps: 6,
    totalSteps: 6,
  });
});

afterAll(async () => {
  await db
    .delete(sandboxProvisioningJobs)
    .where(eq(sandboxProvisioningJobs.id, JOB_ID));
});

describe("sandbox_provisioning_jobs", () => {
  it("platform_admin_role can SELECT every column", async () => {
    const rows = await withPlatformAdminContext((tx) =>
      tx
        .select()
        .from(sandboxProvisioningJobs)
        .where(eq(sandboxProvisioningJobs.id, JOB_ID)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: JOB_ID,
      status: "completed",
      completedSteps: 6,
      totalSteps: 6,
    });
  });

  it("is not reachable at all under a direct app_user SET ROLE with no platform_admin_role switch", async () => {
    let thrown: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        return tx.execute(sql`SELECT 1 FROM sandbox_provisioning_jobs LIMIT 1`);
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const cause = (thrown as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toMatch(/permission denied/i);
  });
});
