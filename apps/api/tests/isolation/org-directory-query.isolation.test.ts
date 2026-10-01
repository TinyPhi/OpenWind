/**
 * End-to-end test of the org-directory query API (T6) against real Postgres —
 * proves RLS + tenant_id filters block cross-tenant reads through the actual
 * query functions the API routes call, not just through runOrgDirectorySync
 * (already covered by org-directory-sync.isolation.test.ts).
 *
 * docs/specs/org-directory.md T9. Requires a live Postgres instance (run with
 * docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, tenants, orgEmployees, orgDirectorySyncRuns } from "@platform/db";
import {
  runOrgDirectorySync,
  getOrgTree,
  getChainToRoot,
  getReportsByLevel,
  getSyncStatus,
  type OrgSourceImporter,
  type OrgSourceRecord,
} from "@platform/org-directory";

const TENANT = "aaaaaaaa-0679-4000-a000-000000000001";
const OTHER_TENANT = "bbbbbbbb-0679-4000-b000-000000000002";

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
    { id: TENANT, name: "Org Query Test", slug: `org-query-${TENANT}` },
    {
      id: OTHER_TENANT,
      name: "Org Query Bystander",
      slug: `org-query-bystander-${OTHER_TENANT}`,
    },
  ]);

  const tree = [
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
    {
      userId: "eng1",
      managerId: "vp",
      department: "engineering",
      name: "Engineer 1",
      title: "Engineer",
      email: "eng1@example.invalid",
    },
  ];
  await runOrgDirectorySync(TENANT, fakeImporter(tree), null);
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
});

afterAll(async () => {
  await cleanupTenant(TENANT);
  await cleanupTenant(OTHER_TENANT);
});

describe("getOrgTree", () => {
  it("returns only this tenant's tree", async () => {
    const tree = await getOrgTree(TENANT);
    expect(tree?.root.name).toBe("Org Query Test");

    const otherTree = await getOrgTree(OTHER_TENANT);
    expect(otherTree?.root.name).toBe("Org Query Bystander");
  });
});

describe("getChainToRoot", () => {
  it("returns the upward chain from a leaf to (but excluding) the root", async () => {
    const chain = await getChainToRoot(TENANT, "eng1");
    expect(chain.map((n) => n.userId)).toEqual(["eng1", "vp", "ceo"]);
  });

  it("returns [] for a userId that belongs to another tenant", async () => {
    const chain = await getChainToRoot(TENANT, "bystander-user");
    expect(chain).toEqual([]);
  });
});

describe("getReportsByLevel", () => {
  it("groups reports by level, direct reports first", async () => {
    const levels = await getReportsByLevel(TENANT, "ceo");
    expect(levels).toHaveLength(2);
    expect(levels[0]?.map((n) => n.userId)).toEqual(["vp"]);
    expect(levels[1]?.map((n) => n.userId)).toEqual(["eng1"]);
  });

  it("returns [] for a leaf employee with no reports", async () => {
    const levels = await getReportsByLevel(TENANT, "eng1");
    expect(levels).toEqual([]);
  });

  it("never returns another tenant's employees for a same-named lookup", async () => {
    const levels = await getReportsByLevel(OTHER_TENANT, "ceo");
    expect(levels).toEqual([]);
  });
});

describe("getSyncStatus", () => {
  it("reports the last successful sync per tenant independently", async () => {
    const status = await getSyncStatus(TENANT);
    expect(status.syncInProgress).toBe(false);
    expect(status.lastSyncOk).toBe(true);
    expect(status.lastSyncedAt).not.toBeNull();
  });
});
