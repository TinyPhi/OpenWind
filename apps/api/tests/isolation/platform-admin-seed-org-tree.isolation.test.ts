/**
 * POST /platform-admin/sandboxes/:tenantId/seed-org-tree (docs/specs/multi-org-sandbox.md R3).
 * Real Postgres and the real route, handler and org-directory sync; only Zitadel is stood in for
 * (an in-memory user list and metadata store) and the platform-admin / fresh-MFA middleware is
 * replaced by a fixed identity, since both are covered by their own suites.
 *
 * Proves the route only ever acts on a sandbox with a mapped org, writes the org tree of that
 * tenant alone, and leaves every other tenant's org tree untouched.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type * as AuthModule from "@platform/auth";
import type * as OrgDirectoryModule from "@platform/org-directory";
import type {
  OrgSourceImporter,
  OrgSourceRecord,
} from "@platform/org-directory";
import type { PlatformAdminAuthContext } from "@platform/auth";
import { db, tenants, orgEmployees, orgDirectorySyncRuns } from "@platform/db";

type OrgMeta = {
  managerId: string | null;
  department: string | null;
  title: string | null;
};
type FakeUser = {
  userId: string;
  displayName: string;
  email: string;
  loginName: string;
};

const zitadel = vi.hoisted(() => ({
  usersByOrg: new Map<string, FakeUser[]>(),
  orgByTenant: new Map<string, string>(),
  metaByUser: new Map<string, OrgMeta>(),
  listCalls: 0,
  setCalls: 0,
}));

vi.mock("@platform/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  type Ctx = Context<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>;
  return {
    ...actual,
    requirePlatformAdmin: () => async (c: Ctx, next: Next) => {
      c.set("platformAdmin", {
        userId: "pa-seed-iso",
        roles: ["platform_admin"],
        email: "ops@example.invalid",
        displayName: "Ops",
      });
      await next();
    },
    requireFreshMfa: () => async (_c: Ctx, next: Next) => {
      await next();
    },
    listOrgUsers: (orgId: string): Promise<FakeUser[]> => {
      zitadel.listCalls++;
      return Promise.resolve(zitadel.usersByOrg.get(orgId) ?? []);
    },
    setUserOrgMetadata: (
      userId: string,
      meta: Partial<OrgMeta>,
    ): Promise<boolean> => {
      zitadel.setCalls++;
      zitadel.metaByUser.set(userId, {
        managerId: meta.managerId ?? null,
        department: meta.department ?? null,
        title: meta.title ?? null,
      });
      return Promise.resolve(true);
    },
    getOrgMetadataForUser: (userId: string): Promise<OrgMeta> =>
      Promise.resolve(
        zitadel.metaByUser.get(userId) ?? {
          managerId: null,
          department: null,
          title: null,
        },
      ),
  };
});

// The org-directory package carries its own compiled copy of the Zitadel calls, so the
// importer is stood in for here too, reading the same in-memory Zitadel. The sync itself
// (tree build, tenant context, advisory lock, writes) is the real one.
vi.mock("@platform/org-directory", async (importOriginal) => {
  const actual = await importOriginal<typeof OrgDirectoryModule>();
  class FakeZitadelImporter implements OrgSourceImporter {
    fetchAll(tenantId: string): Promise<OrgSourceRecord[]> {
      const orgId = zitadel.orgByTenant.get(tenantId);
      const users = (orgId ? zitadel.usersByOrg.get(orgId) : undefined) ?? [];
      return Promise.resolve(
        users.map((u): OrgSourceRecord => {
          const meta = zitadel.metaByUser.get(u.userId);
          return {
            userId: u.userId,
            managerId: meta?.managerId ?? null,
            department: meta?.department ?? null,
            name: u.displayName,
            title: meta?.title ?? "",
            email: u.email,
          };
        }),
      );
    }
  }
  return { ...actual, ZitadelOrgSourceImporter: FakeZitadelImporter };
});

const { sandboxOrgTreeHandler } =
  await import("../../src/routes/platform-admin/sandbox-org-tree.js");

const SANDBOX_A = "aaaaaaaa-0000-4000-a000-000000000081";
const SANDBOX_B = "bbbbbbbb-0000-4000-b000-000000000082";
const SANDBOX_NO_ORG = "cccccccc-0000-4000-c000-000000000083";
const REGULAR = "dddddddd-0000-4000-d000-000000000084";
const ALL = [SANDBOX_A, SANDBOX_B, SANDBOX_NO_ORG, REGULAR];

function usersFor(prefix: string, count: number): FakeUser[] {
  return Array.from({ length: count }, (_, i) => ({
    userId: `${prefix}-user-${i}`,
    displayName: `${prefix} Person ${String(i).padStart(2, "0")}`,
    email: `${prefix}${i}@example.invalid`,
    loginName: `${prefix}${i}`,
  }));
}

function post(tenantId: string): Promise<Response> {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.post("/sandboxes/:tenantId/seed-org-tree", ...sandboxOrgTreeHandler);
  return Promise.resolve(
    app.request(`/sandboxes/${tenantId}/seed-org-tree`, { method: "POST" }),
  );
}

async function rowsOf(tenantId: string) {
  return db
    .select()
    .from(orgEmployees)
    .where(eq(orgEmployees.tenantId, tenantId));
}

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: SANDBOX_A,
      name: "Seed Iso Sandbox A",
      slug: `seed-iso-a-${Date.now()}`,
      isSandbox: true,
      zitadelOrgId: "org-seed-iso-a",
    },
    {
      id: SANDBOX_B,
      name: "Seed Iso Sandbox B",
      slug: `seed-iso-b-${Date.now()}`,
      isSandbox: true,
      zitadelOrgId: "org-seed-iso-b",
    },
    {
      id: SANDBOX_NO_ORG,
      name: "Seed Iso Sandbox Without Org",
      slug: `seed-iso-noorg-${Date.now()}`,
      isSandbox: true,
    },
    {
      id: REGULAR,
      name: "Seed Iso Regular Tenant",
      slug: `seed-iso-reg-${Date.now()}`,
      zitadelOrgId: "org-seed-iso-reg",
    },
  ]);
});

afterAll(async () => {
  for (const id of ALL) {
    await db
      .delete(orgDirectorySyncRuns)
      .where(eq(orgDirectorySyncRuns.tenantId, id));
    await db.delete(orgEmployees).where(eq(orgEmployees.tenantId, id));
  }
  await db.delete(tenants).where(inArray(tenants.id, ALL));
});

beforeEach(() => {
  zitadel.usersByOrg.clear();
  zitadel.orgByTenant.clear();
  zitadel.orgByTenant.set(SANDBOX_A, "org-seed-iso-a");
  zitadel.orgByTenant.set(SANDBOX_B, "org-seed-iso-b");
  zitadel.orgByTenant.set(REGULAR, "org-seed-iso-reg");
  zitadel.metaByUser.clear();
  zitadel.listCalls = 0;
  zitadel.setCalls = 0;
  zitadel.usersByOrg.set("org-seed-iso-a", usersFor("a", 5));
  zitadel.usersByOrg.set("org-seed-iso-b", usersFor("b", 4));
  zitadel.usersByOrg.set("org-seed-iso-reg", usersFor("reg", 4));
});

describe("POST /platform-admin/sandboxes/:tenantId/seed-org-tree", () => {
  it("builds the sandbox's org tree: three managers under the root and a lead under the first two", async () => {
    const res = await post(SANDBOX_A);
    expect(res.status).toBe(200);

    const rows = await rowsOf(SANDBOX_A);
    const root = rows.find((r) => r.isRoot);
    expect(root).toBeDefined();
    expect(rows).toHaveLength(6); // root + 5 accounts

    const idToUser = new Map(rows.map((r) => [r.id, r.userId]));
    const reportsOf = (userId: string): string[] =>
      rows
        .filter(
          (r) => r.parentId !== null && idToUser.get(r.parentId) === userId,
        )
        .map((r) => r.userId ?? "");

    const underRoot = rows.filter((r) => r.parentId === root?.id);
    expect(underRoot).toHaveLength(3);
    expect(reportsOf("a-user-0")).toEqual(["a-user-3"]);
    expect(reportsOf("a-user-1")).toEqual(["a-user-4"]);
    expect(reportsOf("a-user-2")).toEqual([]);
  });

  it("writes only to the sandbox's own org tree and leaves another sandbox's untouched", async () => {
    await post(SANDBOX_A);

    expect(await rowsOf(SANDBOX_B)).toHaveLength(0);
    expect(await rowsOf(REGULAR)).toHaveLength(0);

    await post(SANDBOX_B);

    expect(await rowsOf(SANDBOX_A)).toHaveLength(6);
    expect(await rowsOf(SANDBOX_B)).toHaveLength(5); // root + 4 accounts
    const aUsers = (await rowsOf(SANDBOX_A)).map((r) => r.userId);
    expect(aUsers.every((u) => u === null || u.startsWith("a-"))).toBe(true);
  });

  it("answers 404 for a tenant that is not a sandbox and never calls Zitadel", async () => {
    const res = await post(REGULAR);

    expect(res.status).toBe(404);
    expect(zitadel.listCalls).toBe(0);
    expect(zitadel.setCalls).toBe(0);
    expect(await rowsOf(REGULAR)).toHaveLength(0);
  });

  it("answers 404 for a sandbox with no mapped Zitadel org and for an unknown tenant", async () => {
    expect((await post(SANDBOX_NO_ORG)).status).toBe(404);
    expect((await post("eeeeeeee-0000-4000-e000-000000000085")).status).toBe(
      404,
    );
    expect(zitadel.setCalls).toBe(0);
  });

  it("can be run again and gives the same tree", async () => {
    await post(SANDBOX_A);
    const first = (await rowsOf(SANDBOX_A)).map((r) => [
      r.userId,
      r.title,
      r.department,
    ]);
    await post(SANDBOX_A);
    const second = (await rowsOf(SANDBOX_A)).map((r) => [
      r.userId,
      r.title,
      r.department,
    ]);

    expect(second.sort()).toEqual(first.sort());
  });
});
