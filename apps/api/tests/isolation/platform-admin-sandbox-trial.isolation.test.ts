/**
 * R6a (docs/specs/multi-org-sandbox.md), migration 0142. Real Postgres: the guarantees for trial
 * editing live in platform_admin_extend_sandbox_trial / platform_admin_end_sandbox_trial, so
 * they are tested against the database rather than through the routes' mocked unit tests --
 * sandboxes only, active only, extends stack under concurrency (PR #880 review B), and End only
 * ends a running trial (review C).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  tenants,
  platformAdminAuditLog,
  extendSandboxTrial,
  endSandboxTrial,
  withPlatformAdminContext,
} from "@platform/db";

const SANDBOX_TENANT = "eeeeeeee-0142-4000-e000-000000000142";
const REGULAR_TENANT = "ffffffff-0142-4000-f000-000000000142";
const DELETING_SANDBOX = "dddddddd-0142-4000-d000-000000000142";
const ACTOR = "pa-r6a-isolation";
const DAY = 86_400_000;
const EXPIRED = new Date("2026-01-01T00:00:00.000Z");
const ALL_IDS = [SANDBOX_TENANT, REGULAR_TENANT, DELETING_SANDBOX];

async function trialOf(id: string): Promise<Date | null> {
  const [row] = await db
    .select({ trialEndsAt: tenants.trialEndsAt })
    .from(tenants)
    .where(eq(tenants.id, id));
  return row?.trialEndsAt ?? null;
}

async function setTrial(id: string, value: Date | null): Promise<void> {
  await db
    .update(tenants)
    .set({ trialEndsAt: value })
    .where(eq(tenants.id, id));
}

async function auditActions(id: string): Promise<string[]> {
  const rows = await db
    .select({ action: platformAdminAuditLog.action })
    .from(platformAdminAuditLog)
    .where(eq(platformAdminAuditLog.targetTenantId, id));
  return rows.map((r) => r.action);
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

beforeEach(async () => {
  await db
    .delete(platformAdminAuditLog)
    .where(inArray(platformAdminAuditLog.targetTenantId, ALL_IDS));
});

afterAll(async () => {
  await db
    .delete(platformAdminAuditLog)
    .where(inArray(platformAdminAuditLog.targetTenantId, ALL_IDS));
  await db.delete(tenants).where(inArray(tenants.id, ALL_IDS));
});

describe("platform_admin_extend_sandbox_trial (R6a)", () => {
  it("extends a running trial from its current end, audited", async () => {
    const currentEnd = new Date(Date.now() + 5 * DAY);
    await setTrial(SANDBOX_TENANT, currentEnd);

    const newEnd = await extendSandboxTrial(SANDBOX_TENANT, 7, ACTOR);

    expect(newEnd?.getTime()).toBe(currentEnd.getTime() + 7 * DAY);
    expect((await trialOf(SANDBOX_TENANT))?.getTime()).toBe(newEnd?.getTime());
    expect(await auditActions(SANDBOX_TENANT)).toEqual([
      "sandbox.trial_changed",
    ]);
  });

  it("counts an expired trial from now, reactivating it", async () => {
    await setTrial(SANDBOX_TENANT, EXPIRED);
    const before = Date.now();

    const newEnd = await extendSandboxTrial(SANDBOX_TENANT, 3, ACTOR);

    expect(newEnd?.getTime()).toBeGreaterThanOrEqual(before + 3 * DAY - 1000);
    expect(newEnd?.getTime()).toBeLessThanOrEqual(Date.now() + 3 * DAY + 1000);
  });

  // PR #880 review B: two extends racing on the same row must both apply.
  it("stacks concurrent extends instead of overwriting one with the other", async () => {
    const currentEnd = new Date(Date.now() + 10 * DAY);
    await setTrial(SANDBOX_TENANT, currentEnd);

    await Promise.all([
      extendSandboxTrial(SANDBOX_TENANT, 7, ACTOR),
      extendSandboxTrial(SANDBOX_TENANT, 7, ACTOR),
    ]);

    expect((await trialOf(SANDBOX_TENANT))?.getTime()).toBe(
      currentEnd.getTime() + 14 * DAY,
    );
    expect(await auditActions(SANDBOX_TENANT)).toHaveLength(2);
  });

  it("refuses a regular tenant, leaving it and the audit log untouched", async () => {
    await expect(
      extendSandboxTrial(REGULAR_TENANT, 7, ACTOR),
    ).resolves.toBeNull();

    expect(await trialOf(REGULAR_TENANT)).toBeNull();
    expect(await auditActions(REGULAR_TENANT)).toEqual([]);
  });

  it("refuses a sandbox that is no longer active (being deleted)", async () => {
    await expect(
      extendSandboxTrial(DELETING_SANDBOX, 7, ACTOR),
    ).resolves.toBeNull();

    expect((await trialOf(DELETING_SANDBOX))?.getTime()).toBe(
      EXPIRED.getTime(),
    );
    expect(await auditActions(DELETING_SANDBOX)).toEqual([]);
  });

  it("refuses a day count outside 1..365 even if called directly", async () => {
    await setTrial(SANDBOX_TENANT, null);

    await expect(
      extendSandboxTrial(SANDBOX_TENANT, 0, ACTOR),
    ).resolves.toBeNull();
    await expect(
      extendSandboxTrial(SANDBOX_TENANT, 366, ACTOR),
    ).resolves.toBeNull();
    expect(await trialOf(SANDBOX_TENANT)).toBeNull();
  });
});

describe("platform_admin_end_sandbox_trial (R6a)", () => {
  it("ends a running trial now, audited as sandbox.trial_ended", async () => {
    await setTrial(SANDBOX_TENANT, new Date(Date.now() + 5 * DAY));

    const ended = await endSandboxTrial(SANDBOX_TENANT, ACTOR);

    expect(ended).not.toBeNull();
    expect((await trialOf(SANDBOX_TENANT))?.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    expect(await auditActions(SANDBOX_TENANT)).toEqual(["sandbox.trial_ended"]);
  });

  // PR #880 review C: never turn "no trial" into "expired trial".
  it("refuses a sandbox with no trial, leaving it without one", async () => {
    await setTrial(SANDBOX_TENANT, null);

    await expect(endSandboxTrial(SANDBOX_TENANT, ACTOR)).resolves.toBeNull();

    expect(await trialOf(SANDBOX_TENANT)).toBeNull();
    expect(await auditActions(SANDBOX_TENANT)).toEqual([]);
  });

  it("refuses a trial that has already ended", async () => {
    await setTrial(SANDBOX_TENANT, EXPIRED);

    await expect(endSandboxTrial(SANDBOX_TENANT, ACTOR)).resolves.toBeNull();

    expect((await trialOf(SANDBOX_TENANT))?.getTime()).toBe(EXPIRED.getTime());
  });

  it("refuses a regular tenant", async () => {
    await setTrial(REGULAR_TENANT, new Date(Date.now() + 5 * DAY));

    await expect(endSandboxTrial(REGULAR_TENANT, ACTOR)).resolves.toBeNull();

    expect((await trialOf(REGULAR_TENANT))?.getTime()).toBeGreaterThan(
      Date.now(),
    );
    await setTrial(REGULAR_TENANT, null);
  });
});

describe("trial-function privileges (0142)", () => {
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

  it.each([
    [
      "extend",
      sql`SELECT platform_admin_extend_sandbox_trial(${SANDBOX_TENANT}::uuid, 7)`,
    ],
    [
      "end",
      sql`SELECT platform_admin_end_sandbox_trial(${SANDBOX_TENANT}::uuid)`,
    ],
  ])(
    "does not let app_user execute %s without SET ROLE platform_admin_role",
    async (_name, call) => {
      let caught: unknown;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE app_user`);
          await tx.execute(call);
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect(errorText(caught)).toMatch(/permission denied for function/);
    },
  );
});
