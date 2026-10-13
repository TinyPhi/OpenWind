/**
 * R6a (docs/specs/multi-org-sandbox.md), migration 0142. Real Postgres: the sandbox-only
 * guarantee for trial editing lives in the platform_admin_set_sandbox_trial function, so it
 * is tested here against the database rather than through the route's mocked unit test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  tenants,
  platformAdminAuditLog,
  setSandboxTrialEndsAt,
  withPlatformAdminContext,
} from "@platform/db";

const SANDBOX_TENANT = "eeeeeeee-0142-4000-e000-000000000142";
const REGULAR_TENANT = "ffffffff-0142-4000-f000-000000000142";
const DELETING_SANDBOX = "dddddddd-0142-4000-d000-000000000142";
const ACTOR = "pa-r6a-isolation";
const EXPIRED = new Date("2026-01-01T00:00:00.000Z");

async function trialOf(id: string): Promise<Date | null> {
  const [row] = await db
    .select({ trialEndsAt: tenants.trialEndsAt })
    .from(tenants)
    .where(eq(tenants.id, id));
  return row?.trialEndsAt ?? null;
}

// Drizzle wraps the driver error; the Postgres message is on `cause`.
function errorText(err: unknown): string {
  const cause = (err as { cause?: unknown }).cause;
  return `${String(err)} ${cause instanceof Error ? cause.message : ""}`;
}

beforeAll(async () => {
  await db
    .insert(tenants)
    .values([
      {
        id: SANDBOX_TENANT,
        name: "R6a trial sandbox",
        slug: `r6a-trial-sandbox-${Date.now()}`,
        isSandbox: true,
        trialEndsAt: EXPIRED,
      },
      {
        id: REGULAR_TENANT,
        name: "R6a trial regular tenant",
        slug: `r6a-trial-regular-${Date.now()}`,
      },
      {
        id: DELETING_SANDBOX,
        name: "R6a trial sandbox being deleted",
        slug: `r6a-trial-deleting-${Date.now()}`,
        isSandbox: true,
        status: "deleted",
        trialEndsAt: EXPIRED,
      },
    ])
    .onConflictDoNothing();
});

const ALL_IDS = [SANDBOX_TENANT, REGULAR_TENANT, DELETING_SANDBOX];

async function auditCount(id: string): Promise<number> {
  const rows = await db
    .select({ id: platformAdminAuditLog.id })
    .from(platformAdminAuditLog)
    .where(eq(platformAdminAuditLog.targetTenantId, id));
  return rows.length;
}

afterAll(async () => {
  await db
    .delete(platformAdminAuditLog)
    .where(inArray(platformAdminAuditLog.targetTenantId, ALL_IDS));
  await db.delete(tenants).where(inArray(tenants.id, ALL_IDS));
});

describe("platform_admin_set_sandbox_trial (R6a)", () => {
  it("moves an expired sandbox's trial into the future (reactivation)", async () => {
    const newEnd = new Date(Date.now() + 7 * 86_400_000);

    await expect(
      setSandboxTrialEndsAt(SANDBOX_TENANT, newEnd, ACTOR),
    ).resolves.toBe(true);

    expect((await trialOf(SANDBOX_TENANT))?.getTime()).toBe(newEnd.getTime());
    expect(await auditCount(SANDBOX_TENANT)).toBe(1);
  });

  it("refuses a regular tenant and leaves its trial untouched", async () => {
    const newEnd = new Date(Date.now() + 7 * 86_400_000);

    await expect(
      setSandboxTrialEndsAt(REGULAR_TENANT, newEnd, ACTOR),
    ).resolves.toBe(false);

    expect(await trialOf(REGULAR_TENANT)).toBeNull();
    // The audit row is in the same transaction, so a refused change leaves none behind.
    expect(await auditCount(REGULAR_TENANT)).toBe(0);
  });

  it("refuses a sandbox that is no longer active (being deleted)", async () => {
    await expect(
      setSandboxTrialEndsAt(
        DELETING_SANDBOX,
        new Date(Date.now() + 86_400_000),
        ACTOR,
      ),
    ).resolves.toBe(false);

    expect((await trialOf(DELETING_SANDBOX))?.getTime()).toBe(
      EXPIRED.getTime(),
    );
    expect(await auditCount(DELETING_SANDBOX)).toBe(0);
  });

  it("returns false for an id that matches no tenant", async () => {
    await expect(
      setSandboxTrialEndsAt(
        "00000000-0142-4000-8000-000000000000",
        new Date(Date.now() + 86_400_000),
        ACTOR,
      ),
    ).resolves.toBe(false);
  });

  it("still gives platform_admin_role no direct UPDATE on tenants", async () => {
    let caught: unknown;
    try {
      await withPlatformAdminContext((tx) =>
        tx
          .update(tenants)
          .set({ trialEndsAt: new Date() })
          .where(eq(tenants.id, REGULAR_TENANT)),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(errorText(caught)).toMatch(/permission denied/);
    expect(await trialOf(REGULAR_TENANT)).toBeNull();
  });

  it("is not executable by app_user without SET ROLE platform_admin_role", async () => {
    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT platform_admin_set_sandbox_trial(${SANDBOX_TENANT}::uuid, now())`,
        );
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(errorText(caught)).toMatch(/permission denied for function/);
  });
});
