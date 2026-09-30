/**
 * End-to-end test of runOrgDirectorySync against real Postgres — the tree
 * algorithm itself is unit-tested in packages/org-directory (no DB needed);
 * this exercises the DB wiring around it: the concurrency lock, transactional
 * upsert, root creation/reuse, and the fixture's own cross-tenant boundary.
 *
 * docs/specs/org-directory.md T4. Requires a live Postgres instance (run with
 * docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  orgEmployees,
  orgDirectorySyncRuns,
  acquireTenantAdvisoryLock,
} from "@platform/db";
import {
  runOrgDirectorySync,
  type OrgSourceImporter,
  type OrgSourceRecord,
} from "@platform/org-directory";

const TENANT = "aaaaaaaa-0579-4000-a000-000000000001";
const OTHER_TENANT = "bbbbbbbb-0579-4000-b000-000000000002";

function fakeImporter(records: OrgSourceRecord[]): OrgSourceImporter {
  return { fetchAll: async () => records };
}

async function cleanupTenant(tenantId: string): Promise<void> {
  await db
    .delete(orgDirectorySyncRuns)
    .where(eq(orgDirectorySyncRuns.tenantId, tenantId));
  await db.delete(orgEmployees).where(eq(orgEmployees.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
}

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT,
      name: "Org Directory Sync Test",
      slug: `org-directory-sync-${TENANT}`,
    },
    {
      id: OTHER_TENANT,
      name: "Org Directory Sync Bystander",
      slug: `org-directory-sync-bystander-${OTHER_TENANT}`,
    },
  ]);
});

afterAll(async () => {
  await cleanupTenant(TENANT);
  await cleanupTenant(OTHER_TENANT);
});

describe("runOrgDirectorySync", () => {
  it("creates the root and a full tree on first sync", async () => {
    const result = await runOrgDirectorySync(
      TENANT,
      fakeImporter([
        {
          userId: "ceo",
          managerId: null,
          department: "Executive",
          name: "CEO",
          title: "Chief Executive",
          email: "ceo@example.invalid",
        },
        {
          userId: "vp",
          managerId: "ceo",
          department: "engineering",
          name: "VP Eng",
          title: "VP",
          email: "vp@example.invalid",
        },
      ]),
      null,
    );

    expect(result.status).toBe("completed");
    expect(result.employeeCount).toBe(2);

    const rows = await db
      .select()
      .from(orgEmployees)
      .where(eq(orgEmployees.tenantId, TENANT));
    const root = rows.find((r) => r.isRoot);
    const ceo = rows.find((r) => r.userId === "ceo");
    const vp = rows.find((r) => r.userId === "vp");

    expect(root?.name).toBe("Org Directory Sync Test");
    expect(ceo?.parentId).toBe(root?.id);
    expect(vp?.parentId).toBe(ceo?.id);
    expect(vp?.department).toBe("engineering");
  });

  it("reparents a manager's reports one hop up when that manager disappears on the next sync", async () => {
    await runOrgDirectorySync(
      TENANT,
      fakeImporter([
        {
          userId: "ceo",
          managerId: null,
          department: null,
          name: "CEO",
          title: "",
          email: "",
        },
        {
          userId: "manager",
          managerId: "ceo",
          department: null,
          name: "Manager",
          title: "",
          email: "",
        },
        {
          userId: "report",
          managerId: "manager",
          department: null,
          name: "Report",
          title: "",
          email: "",
        },
      ]),
      null,
    );

    const result = await runOrgDirectorySync(
      TENANT,
      fakeImporter([
        {
          userId: "ceo",
          managerId: null,
          department: null,
          name: "CEO",
          title: "",
          email: "",
        },
        {
          userId: "report",
          managerId: "manager",
          department: null,
          name: "Report",
          title: "",
          email: "",
        },
      ]),
      null,
    );

    expect(result.status).toBe("completed");
    expect(result.reparented).toBe(1);

    const rows = await db
      .select()
      .from(orgEmployees)
      .where(eq(orgEmployees.tenantId, TENANT));
    const ceo = rows.find((r) => r.userId === "ceo");
    const report = rows.find((r) => r.userId === "report");
    const manager = rows.find((r) => r.userId === "manager");

    expect(manager).toBeUndefined();
    expect(report?.parentId).toBe(ceo?.id);
  });

  it("deletes a chain of removed employees without hitting the parent_id FK constraint (PR713 review fix)", async () => {
    // A's parent is CEO; B's parent is A. Both A and B disappear from the
    // next pull, and nothing else references either -- without nulling each
    // removed row's own parent_id before deleting, deleting A first (B.parent_id
    // still = A.id) would fail the FK check regardless of iteration order.
    await runOrgDirectorySync(
      TENANT,
      fakeImporter([
        {
          userId: "ceo2",
          managerId: null,
          department: null,
          name: "CEO",
          title: "",
          email: "",
        },
        {
          userId: "chain-a",
          managerId: "ceo2",
          department: null,
          name: "A",
          title: "",
          email: "",
        },
        {
          userId: "chain-b",
          managerId: "chain-a",
          department: null,
          name: "B",
          title: "",
          email: "",
        },
      ]),
      null,
    );

    const result = await runOrgDirectorySync(
      TENANT,
      fakeImporter([
        {
          userId: "ceo2",
          managerId: null,
          department: null,
          name: "CEO",
          title: "",
          email: "",
        },
      ]),
      null,
    );

    expect(result.status).toBe("completed");

    const rows = await db
      .select({ userId: orgEmployees.userId })
      .from(orgEmployees)
      .where(eq(orgEmployees.tenantId, TENANT));
    const userIds = rows.map((r) => r.userId);
    expect(userIds).not.toContain("chain-a");
    expect(userIds).not.toContain("chain-b");
  });

  it("rejects a sync for a tenant that already holds the advisory lock", async () => {
    // Deterministic instead of racing two real async sync calls: acquire the
    // same advisory lock runOrgDirectorySync itself would take, directly, and
    // assert a sync attempt against the held tenant is rejected. Namespace
    // string must match sync.ts's ADVISORY_LOCK_NAMESPACE exactly.
    const lock = await acquireTenantAdvisoryLock(TENANT, "org-directory-sync");
    expect(lock.acquired).toBe(true);

    const result = await runOrgDirectorySync(TENANT, fakeImporter([]), null);
    expect(result.status).toBe("already_running");

    await lock.release();
  });

  it("allows a sync immediately after the lock is released — no artificial holdover", async () => {
    const lock = await acquireTenantAdvisoryLock(TENANT, "org-directory-sync");
    await lock.release();

    const result = await runOrgDirectorySync(TENANT, fakeImporter([]), null);
    expect(result.status).toBe("completed");
  });

  it("reclaims a stale 'running' row left by a crashed prior sync (PR713 review fix)", async () => {
    // Simulates a crash: a 'running' row exists with no live process holding
    // the advisory lock (the lock itself was already freed by the crash --
    // that part always worked). Before this fix, the next sync's own insert
    // would fail against org_directory_sync_runs_one_running_per_tenant and
    // the tenant would be locked out until manual DB intervention.
    const [staleRun] = await db
      .insert(orgDirectorySyncRuns)
      .values({ tenantId: TENANT, status: "running" })
      .returning({ id: orgDirectorySyncRuns.id });

    const result = await runOrgDirectorySync(TENANT, fakeImporter([]), null);
    expect(result.status).toBe("completed");

    const [reclaimed] = await db
      .select({ status: orgDirectorySyncRuns.status })
      .from(orgDirectorySyncRuns)
      .where(eq(orgDirectorySyncRuns.id, staleRun!.id));
    expect(reclaimed?.status).toBe("failed");
  });

  it("holds the lock across the external fetch gap, not just around the DB writes", async () => {
    // Proves runOrgDirectorySync itself (not just the underlying primitive)
    // keeps the lock held while importer.fetchAll is in flight -- a
    // regression that released and re-acquired the lock between the
    // sync-run insert and the tree-rebuild transaction would slip past a
    // test that only exercises acquireTenantAdvisoryLock directly.
    let releaseFetch: (() => void) | undefined;
    const blockedFetch = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const slowImporter: OrgSourceImporter = {
      fetchAll: async () => {
        await blockedFetch;
        return [];
      },
    };

    const first = runOrgDirectorySync(TENANT, slowImporter, null);
    // Poll for the lock to be contended rather than a fixed sleep -- avoids
    // the flakiness the original concurrency test had, since this waits on
    // an actual condition (the first call's lock acquisition landing) with a
    // generous ceiling, not a fixed guess at how long that takes.
    let second: Awaited<ReturnType<typeof runOrgDirectorySync>> | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      second = await runOrgDirectorySync(TENANT, fakeImporter([]), null);
      if (second.status === "already_running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(second?.status).toBe("already_running");

    releaseFetch?.();
    const firstResult = await first;
    expect(firstResult.status).toBe("completed");
  });

  it("does not touch another tenant's org_employees rows", async () => {
    await runOrgDirectorySync(
      OTHER_TENANT,
      fakeImporter([
        {
          userId: "bystander-user",
          managerId: null,
          department: null,
          name: "Bystander",
          title: "",
          email: "",
        },
      ]),
      null,
    );

    const tenantRows = await db
      .select({ userId: orgEmployees.userId })
      .from(orgEmployees)
      .where(eq(orgEmployees.tenantId, TENANT));
    const otherRows = await db
      .select({ userId: orgEmployees.userId })
      .from(orgEmployees)
      .where(eq(orgEmployees.tenantId, OTHER_TENANT));

    expect(tenantRows.map((r) => r.userId)).not.toContain("bystander-user");
    expect(otherRows.map((r) => r.userId)).toContain("bystander-user");
  });
});
