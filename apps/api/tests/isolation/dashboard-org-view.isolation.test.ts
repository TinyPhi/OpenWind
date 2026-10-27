/**
 * Isolation tests for GET /dashboard/org-view and /dashboard/team-member-view/:userId
 * (docs/specs/my-org-view.md R2, R5, R9, R10). Run against a real Postgres instance, no mocks:
 * the org tree is built by the real sync, tickets are seeded directly via `db`, and the real
 * handlers are mounted with a fake auth context.
 *
 * Tenant B deliberately reuses Tenant A's user id for one person, so a lookup that ignored the
 * tenant would find them.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  tenants,
  entityTypes,
  entityInstances,
  orgEmployees,
  orgDirectorySyncRuns,
} from "@platform/db";
import type { AuthContext } from "@platform/auth";
import {
  runOrgDirectorySync,
  type OrgSourceImporter,
  type OrgSourceRecord,
} from "@platform/org-directory";
import {
  orgViewHandler,
  orgViewHasReportsHandler,
} from "../../src/routes/dashboard/org-view.js";
import { teamMemberViewHandler } from "../../src/routes/dashboard/team-member-view.js";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000071";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000072";

// Tenant A tree:  boss -> lead -> emp ;  boss -> other-lead ; stranger (separate branch, no manager)
const BOSS = "ov-boss";
const LEAD = "ov-lead";
const EMP = "ov-emp";
const OTHER_LEAD = "ov-other-lead";
// Tenant B reuses EMP's id for a different person with their own ticket.
const B_EMP_SAME_ID = EMP;
const B_ONLY_USER = "ov-b-only";

let entityTypeId: string;

function person(
  userId: string,
  managerId: string | null,
  name: string,
): OrgSourceRecord {
  return {
    userId,
    managerId,
    department: null,
    name,
    title: "",
    email: `${userId}@example.invalid`,
  };
}

function importer(records: OrgSourceRecord[]): OrgSourceImporter {
  return { fetchAll: () => Promise.resolve(records) };
}

async function ticket(
  tenantId: string,
  title: string,
  who: {
    createdBy?: string;
    assignedTo?: string;
    accessUsers?: string[];
    deletedAt?: Date;
  },
): Promise<string> {
  const [row] = await db
    .insert(entityInstances)
    .values({
      tenantId,
      entityTypeId,
      currentState: "open",
      fields: {
        title,
        ...(who.accessUsers ? { __accessUsers: who.accessUsers } : {}),
      },
      createdBy: who.createdBy ?? "someone-unrelated",
      assignedTo: who.assignedTo ?? null,
      deletedAt: who.deletedAt,
    })
    .returning({ id: entityInstances.id });
  if (!row) throw new Error("ticket insert failed");
  return row.id;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT_A, name: "OV Tenant A", slug: `ov-a-${Date.now()}` },
    { id: TENANT_B, name: "OV Tenant B", slug: `ov-b-${Date.now()}` },
  ]);
  const [et] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `ov_${Date.now()}`,
      plural: `ovs_${Date.now()}`,
      allowCustomFields: true,
    })
    .returning();
  if (!et) throw new Error("entity type insert failed");
  entityTypeId = et.id;

  await runOrgDirectorySync(
    TENANT_A,
    importer([
      person(BOSS, null, "Boss"),
      person(LEAD, BOSS, "Lead"),
      person(EMP, LEAD, "Emp"),
      person(OTHER_LEAD, BOSS, "Other Lead"),
      person("ov-stranger", null, "Stranger"),
    ]),
    null,
  );
  await runOrgDirectorySync(
    TENANT_B,
    importer([
      person(B_ONLY_USER, null, "B Only"),
      person(B_EMP_SAME_ID, B_ONLY_USER, "B Emp"),
    ]),
    null,
  );

  ids.bossOwn = await ticket(TENANT_A, "boss own", { assignedTo: BOSS });
  ids.empAssigned = await ticket(TENANT_A, "emp assigned", {
    assignedTo: EMP,
  });
  ids.leadCreated = await ticket(TENANT_A, "lead created", {
    createdBy: LEAD,
  });
  // A report created it but it is assigned outside the caller's subtree.
  ids.sharedWithOutsider = await ticket(TENANT_A, "emp created", {
    createdBy: EMP,
    assignedTo: "ov-stranger",
  });
  ids.strangerTicket = await ticket(TENANT_A, "stranger's", {
    assignedTo: "ov-stranger",
  });
  ids.accessGrant = await ticket(TENANT_A, "shared with lead", {
    accessUsers: [LEAD],
  });
  ids.softDeleted = await ticket(TENANT_A, "deleted lead ticket", {
    assignedTo: LEAD,
    deletedAt: new Date(),
  });
  ids.bTicket = await ticket(TENANT_B, "tenant b ticket", {
    assignedTo: B_EMP_SAME_ID,
  });
});

afterAll(async () => {
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityTypeId));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
  for (const t of [TENANT_A, TENANT_B]) {
    await db
      .delete(orgDirectorySyncRuns)
      .where(eq(orgDirectorySyncRuns.tenantId, t));
    await db.delete(orgEmployees).where(eq(orgEmployees.tenantId, t));
  }
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

function makeApp(tenantId: string, userId: string): Hono {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId,
        roles: ["user"],
        email: "t@example.com",
        displayName: userId,
      } as unknown as AuthContext);
      await next();
    },
  );
  app.get("/org-view", ...orgViewHandler);
  app.get("/org-view/has-reports", ...orgViewHasReportsHandler);
  app.get("/team-member-view/:userId", ...teamMemberViewHandler);
  return app as unknown as Hono;
}

interface OrgViewBody {
  data: {
    hasReports: boolean;
    tickets: {
      items: { entityId: string; assignedTo?: string | null }[];
      totalQualifying: number;
    };
    teamMembers: { items: { userId: string }[] };
  };
}

describe("GET /dashboard/org-view", () => {
  it("probes report availability within the caller's tenant and ignores null-user rows", async () => {
    const bossProbe = await makeApp(TENANT_A, BOSS).request(
      "/org-view/has-reports",
    );
    expect(await bossProbe.json()).toEqual({ data: { hasReports: true } });

    const [employee] = await db
      .select({ id: orgEmployees.id })
      .from(orgEmployees)
      .where(
        and(eq(orgEmployees.tenantId, TENANT_A), eq(orgEmployees.userId, EMP)),
      );
    if (!employee) throw new Error("employee row missing");
    const [invalid] = await db
      .insert(orgEmployees)
      .values({
        tenantId: TENANT_A,
        userId: null,
        parentId: employee.id,
        name: "Invalid null user",
        isRoot: false,
      })
      .returning({ id: orgEmployees.id });
    try {
      const leafProbe = await makeApp(TENANT_A, EMP).request(
        "/org-view/has-reports",
      );
      expect(await leafProbe.json()).toEqual({
        data: { hasReports: false },
      });
    } finally {
      if (invalid) {
        await db.delete(orgEmployees).where(eq(orgEmployees.id, invalid.id));
      }
    }
  });

  it("includes the caller's own tickets and every report's, at any depth", async () => {
    const res = await makeApp(TENANT_A, BOSS).request("/org-view");
    const { data } = (await res.json()) as OrgViewBody;

    const got = data.tickets.items.map((t) => t.entityId);
    expect(data.hasReports).toBe(true);
    expect(got).toEqual(
      expect.arrayContaining([ids.bossOwn, ids.empAssigned, ids.leadCreated]),
    );
  });

  it("never includes a ticket belonging to someone outside the caller's subtree", async () => {
    const res = await makeApp(TENANT_A, BOSS).request("/org-view");
    const { data } = (await res.json()) as OrgViewBody;

    expect(data.tickets.items.map((t) => t.entityId)).not.toContain(
      ids.strangerTicket,
    );
    expect(data.teamMembers.items.map((m) => m.userId).sort()).toEqual(
      [EMP, LEAD, OTHER_LEAD].sort(),
    );
  });

  it("includes a ticket a report created but hides the outside assignee's id and name", async () => {
    const res = await makeApp(TENANT_A, BOSS).request("/org-view");
    const { data } = (await res.json()) as OrgViewBody;

    const item = data.tickets.items.find(
      (t) => t.entityId === ids.sharedWithOutsider,
    );
    expect(item).toBeDefined();
    expect(item).toMatchObject({ assignedTo: null, assignedToName: null });
  });

  it("includes a real Postgres __accessUsers grant and excludes soft-deleted tickets", async () => {
    const res = await makeApp(TENANT_A, BOSS).request("/org-view");
    const { data } = (await res.json()) as OrgViewBody;
    const got = data.tickets.items.map((t) => t.entityId);

    expect(got).toContain(ids.accessGrant);
    expect(got).not.toContain(ids.softDeleted);
  });

  it("never includes another tenant's ticket, even for a user id that exists in both tenants", async () => {
    const res = await makeApp(TENANT_A, BOSS).request("/org-view");
    const { data } = (await res.json()) as OrgViewBody;

    expect(data.tickets.items.map((t) => t.entityId)).not.toContain(
      ids.bTicket,
    );
  });

  it("scopes a middle manager to their own branch only", async () => {
    const res = await makeApp(TENANT_A, LEAD).request("/org-view");
    const { data } = (await res.json()) as OrgViewBody;

    const got = data.tickets.items.map((t) => t.entityId);
    expect(got).toContain(ids.empAssigned);
    expect(got).not.toContain(ids.bossOwn);
  });

  it("does not duplicate or expose the caller when a residual cycle reaches the API", async () => {
    const rows = await db
      .select({
        id: orgEmployees.id,
        userId: orgEmployees.userId,
        parentId: orgEmployees.parentId,
        isRoot: orgEmployees.isRoot,
      })
      .from(orgEmployees)
      .where(eq(orgEmployees.tenantId, TENANT_A));
    const boss = rows.find((row) => row.userId === BOSS);
    const lead = rows.find((row) => row.userId === LEAD);
    const root = rows.find((row) => row.isRoot);
    if (!boss || !lead || !root) throw new Error("org rows missing");

    await db
      .update(orgEmployees)
      .set({ parentId: lead.id })
      .where(eq(orgEmployees.id, boss.id));
    try {
      const res = await makeApp(TENANT_A, BOSS).request("/org-view");
      const { data } = (await res.json()) as OrgViewBody;
      const memberIds = data.teamMembers.items.map((member) => member.userId);

      expect(memberIds).not.toContain(BOSS);
      expect(new Set(memberIds).size).toBe(memberIds.length);
      expect(memberIds).toEqual(expect.arrayContaining([LEAD, EMP]));
    } finally {
      await db
        .update(orgEmployees)
        .set({ parentId: root.id })
        .where(eq(orgEmployees.id, boss.id));
    }
  });

  it("keeps Tenant A tickets out of Tenant B's org view", async () => {
    const res = await makeApp(TENANT_B, B_ONLY_USER).request("/org-view");
    const { data } = (await res.json()) as OrgViewBody;
    const got = data.tickets.items.map((ticket) => ticket.entityId);

    expect(got).toContain(ids.bTicket);
    for (const tenantAId of Object.values(ids).filter(
      (id) => id !== ids.bTicket,
    )) {
      expect(got).not.toContain(tenantAId);
    }
  });

  it("reports hasReports:false for a leaf, and for a user who is not in the tree", async () => {
    for (const user of [EMP, "ov-nobody"]) {
      const res = await makeApp(TENANT_A, user).request("/org-view");
      const { data } = (await res.json()) as OrgViewBody;
      expect(data.hasReports).toBe(false);
      expect(data.tickets.items).toEqual([]);
    }
  });
});

describe("GET /dashboard/team-member-view/:userId", () => {
  it("shows a report's tickets to their manager, at any depth", async () => {
    const res = await makeApp(TENANT_A, BOSS).request(
      `/team-member-view/${EMP}`,
    );
    const body = (await res.json()) as OrgViewBody;

    expect(res.status).toBe(200);
    // Assigned to EMP, plus the one EMP created: nothing of anyone else's.
    expect(body.data.tickets.items.map((t) => t.entityId).sort()).toEqual(
      [ids.empAssigned, ids.sharedWithOutsider].sort(),
    );
  });

  it.each([
    ["a person outside the caller's subtree", "ov-stranger"],
    ["the caller themself", BOSS],
    ["a user who exists only in another tenant", B_ONLY_USER],
    ["an unknown id", "ov-nobody"],
  ])("answers 404 for %s", async (_label, target) => {
    const res = await makeApp(TENANT_A, BOSS).request(
      `/team-member-view/${target}`,
    );

    expect(res.status).toBe(404);
  });

  it("answers 404 when a leaf tries to view anyone", async () => {
    const res = await makeApp(TENANT_A, EMP).request(
      `/team-member-view/${LEAD}`,
    );

    expect(res.status).toBe(404);
  });

  it("never lets Tenant B reach Tenant A's people by id", async () => {
    const res = await makeApp(TENANT_B, B_ONLY_USER).request(
      `/team-member-view/${LEAD}`,
    );

    expect(res.status).toBe(404);
  });

  it("shows Tenant B's reused user id without leaking Tenant A tickets", async () => {
    const res = await makeApp(TENANT_B, B_ONLY_USER).request(
      `/team-member-view/${B_EMP_SAME_ID}`,
    );
    const body = (await res.json()) as OrgViewBody;
    const got = body.data.tickets.items.map((ticket) => ticket.entityId);

    expect(res.status).toBe(200);
    expect(got).toEqual([ids.bTicket]);
    for (const tenantAId of Object.values(ids).filter(
      (id) => id !== ids.bTicket,
    )) {
      expect(got).not.toContain(tenantAId);
    }
  });
});
