import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const { mockAuth, mockWriteAuditEntry, mockReplaceMembers } = vi.hoisted(
  () => ({
    mockAuth: {
      tenantId: "t-aaa",
      userId: "u-bbb",
      orgId: "org-1",
      roles: ["admin"] as string[],
      email: "test@example.com",
    },
    mockWriteAuditEntry: vi.fn(),
    mockReplaceMembers: vi.fn(),
  }),
);

let orgRoles = new Map<string, string[]>();
let rolesLookupFails = false;
let deleteCalls = 0;
let rolesLookups = 0;
let memberRows: { teamId: string; userId: string; position: number }[] = [];
// What the locked team really held when the write ran; null means the same as memberRows
let lockedMembers: string[] | null = null;
let takenElsewhere: { userId: string; teamName: string }[] = [];

vi.mock("../../lib/zitadel-management.js", () => ({
  listUserRolesByUserId: () =>
    (rolesLookups++, rolesLookupFails)
      ? Promise.reject(new Error("zitadel unavailable"))
      : Promise.resolve(orgRoles),
}));

vi.mock("../../lib/ensure-user-refs.js", () => ({
  resolveTenantMembers: () => Promise.resolve(new Set<string>()),
}));

vi.mock("@platform/teams", () => ({
  replaceTeamMembers: (...args: unknown[]) => {
    mockReplaceMembers(...args);
    return Promise.resolve(lockedMembers ?? memberRows.map((m) => m.userId));
  },
}));

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth as AuthContext);
      await next();
    },
  requireRole:
    (...allowedRoles: string[]) =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      const auth = c.get("auth");
      if (!auth?.roles.some((r) => allowedRoles.includes(r))) {
        return c.json({ error: "FORBIDDEN" }, 403);
      }
      await next();
    },
}));

const mockTeamRow = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "t-aaa",
  name: "Platform Engineering",
  description: null,
  createdBy: "u-bbb",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

let insertShouldConflict = false;
let updateShouldConflict = false;
let updateReturnsRow = true;
let deleteReturnsRow = true;
let getReturnsRow = true;

vi.mock("@platform/db", () => ({
  db: {},
  teamMembers: {
    tenantId: "tenantId",
    teamId: "teamId",
    userId: "userId",
    position: "position",
  },
  teams: {
    id: "id",
    tenantId: "tenantId",
    name: "name",
    createdAt: "createdAt",
    deletedAt: "deletedAt",
  },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      select: () => tx,
      from: () => tx,
      where: () => tx,
      innerJoin: () => tx,
      // awaiting select().from().innerJoin().where() is the "already on another team" lookup
      then: (resolve: (rows: unknown) => unknown) => resolve(takenElsewhere),
      orderBy: () =>
        Object.assign(Promise.resolve(memberRows), {
          limit: () => Promise.resolve(getReturnsRow ? [mockTeamRow] : []),
        }),
      limit: () => Promise.resolve(getReturnsRow ? [mockTeamRow] : []),
      delete: () => {
        deleteCalls++;
        return tx;
      },
      insert: () => tx,
      values: () => tx,
      update: () => tx,
      set: () => tx,
      returning: () => {
        if (insertShouldConflict || updateShouldConflict) {
          const err = new Error("duplicate key");
          (err as unknown as { cause: { code: string } }).cause = {
            code: "23505",
          };
          throw err;
        }
        if (!updateReturnsRow || !deleteReturnsRow) return Promise.resolve([]);
        return Promise.resolve([mockTeamRow]);
      },
    };
    return fn(tx);
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => {
    mockWriteAuditEntry(...args);
    return Promise.resolve();
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  asc: (...args: unknown[]) => ({ op: "asc", args }),
  inArray: (...args: unknown[]) => ({ op: "inArray", args }),
  eq: (...args: unknown[]) => ({ op: "eq", args }),
  gt: (...args: unknown[]) => ({ op: "gt", args }),
  ne: (...args: unknown[]) => ({ op: "ne", args }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  isNull: (...args: unknown[]) => ({ op: "isNull", args }),
}));

const { teamsRouter } = await import("./teams.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/admin/teams", teamsRouter);
  return app;
}

// Reset ALL shared mutable fixture flags before every single test, not just
// per-describe -- these are module-level `let`s shared across every describe
// block in this file, and a flag flipped in one test otherwise leaks into
// the next describe block's tests (execution order, not describe order).
beforeEach(() => {
  takenElsewhere = [];
  mockAuth.roles = ["admin"];
  lockedMembers = null;
  insertShouldConflict = false;
  updateShouldConflict = false;
  updateReturnsRow = true;
  deleteReturnsRow = true;
  getReturnsRow = true;
  orgRoles = new Map([
    ["u-1", ["agent"]],
    ["u-2", ["user"]],
    ["u-3", ["admin"]],
    ["u-customer", ["guest"]],
  ]);
  rolesLookupFails = false;
  memberRows = [];
  deleteCalls = 0;
  rolesLookups = 0;
  mockReplaceMembers.mockReset();
  mockWriteAuditEntry.mockReset();
});

describe("GET /admin/teams — role enforcement", () => {
  it("returns 200 for admin role", async () => {
    const res = await makeApp().request("/admin/teams");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("data");
  });

  it("returns 200 for agent role (read allowed)", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/teams");
    expect(res.status).toBe(200);
  });

  // docs/specs/team-assign-oncall-fallback.md R1/AC6 -- widened from
  // agent/admin-only so the customer-facing ticket-creation form
  // (record-create.tsx, reachable by plain "user" role) can populate its
  // Team assign-mode picker. Read-only, no data exposed beyond team
  // name/id that agent/admin already see.
  it("returns 200 for user role (read widened for ticket-form team pickers)", async () => {
    mockAuth.roles = ["user"];
    const res = await makeApp().request("/admin/teams");
    expect(res.status).toBe(200);
  });

  it("returns 403 for a role with none of agent/admin/user", async () => {
    mockAuth.roles = ["guest"];
    const res = await makeApp().request("/admin/teams");
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/teams/:id", () => {
  it("returns 200 with the team when it exists", async () => {
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(mockTeamRow.id);
  });

  it("returns 404 when the team does not exist (or belongs to another tenant)", async () => {
    getReturnsRow = false;
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/teams — role enforcement + create", () => {
  it("returns 403 for agent role (write is admin-only)", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Platform Engineering" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 201 for admin role with a valid body", async () => {
    const res = await makeApp().request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Platform Engineering" }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 400 when name is missing", async () => {
    const res = await makeApp().request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the team name already exists in this tenant (R3)", async () => {
    insertShouldConflict = true;
    const res = await makeApp().request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Platform Engineering" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("PATCH /admin/teams/:id", () => {
  it("returns 200 when the team exists", async () => {
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 when the team does not exist (or belongs to another tenant)", async () => {
    updateReturnsRow = false;
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when renaming to a name that already exists in this tenant (R3)", async () => {
    updateShouldConflict = true;
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Platform Engineering" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("DELETE /admin/teams/:id", () => {
  it("returns 204 on successful soft-delete", async () => {
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  it("returns 404 when the team does not exist", async () => {
    deleteReturnsRow = false;
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});

function putMembers(memberUserIds: string[]): Promise<Response> {
  return makeApp().request(`/admin/teams/${mockTeamRow.id}/members`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memberUserIds }),
  });
}

describe("team members (oncall-team-rotation R1)", () => {
  it("lists each team's members in position order", async () => {
    memberRows = [
      { teamId: mockTeamRow.id, userId: "u-2", position: 0 },
      { teamId: mockTeamRow.id, userId: "u-1", position: 1 },
    ];
    const res = await makeApp().request("/admin/teams");
    const json = await res.json();
    expect(json.data[0].members).toEqual([
      { userId: "u-2", position: 0 },
      { userId: "u-1", position: 1 },
    ]);
  });

  it("returns an empty members list for a team with none", async () => {
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`);
    expect((await res.json()).data.members).toEqual([]);
  });

  it("creates a team with its ordered members in one request", async () => {
    const res = await makeApp().request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ops", memberUserIds: ["u-2", "u-1"] }),
    });
    expect(res.status).toBe(201);
    expect(mockReplaceMembers.mock.calls[0]?.[3]).toEqual(["u-2", "u-1"]);
    expect((await res.json()).data.members).toEqual([
      { userId: "u-2", position: 0 },
      { userId: "u-1", position: 1 },
    ]);
  });

  it("refuses a create whose member is not an eligible org user, writing nothing", async () => {
    const res = await makeApp().request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops",
        memberUserIds: ["u-1", "u-other-org"],
      }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).fields[0].field).toBe("memberUserIds[1]");
    expect(mockReplaceMembers).not.toHaveBeenCalled();
  });

  it("replaces members with PUT and audits the before and after lists", async () => {
    memberRows = [{ teamId: mockTeamRow.id, userId: "u-1", position: 0 }];
    const res = await putMembers(["u-3", "u-1"]);
    expect(res.status).toBe(200);
    expect(mockReplaceMembers.mock.calls[0]?.[3]).toEqual(["u-3", "u-1"]);
    expect(mockWriteAuditEntry.mock.calls[0]?.[1]).toMatchObject({
      resourceType: "team",
      action: "updated",
      beforeSnapshot: { memberUserIds: ["u-1"] },
      afterSnapshot: { memberUserIds: ["u-3", "u-1"] },
    });
  });

  it("accepts an empty list (a team with no members stays valid)", async () => {
    expect((await putMembers([])).status).toBe(200);
  });

  it("refuses a user without an on-call role with 422", async () => {
    const res = await putMembers(["u-customer"]);
    expect(res.status).toBe(422);
    expect(mockReplaceMembers).not.toHaveBeenCalled();
  });

  it("refuses a duplicate member with 422", async () => {
    const res = await putMembers(["u-1", "u-1"]);
    expect(res.status).toBe(422);
    expect((await res.json()).fields[0].field).toBe("memberUserIds[1]");
  });

  it("refuses more than 100 members with 400", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `u-${i}`);
    expect((await putMembers(ids)).status).toBe(400);
  });

  it("returns 503 when the role lookup is unavailable", async () => {
    rolesLookupFails = true;
    expect((await putMembers(["u-1"])).status).toBe(503);
  });

  it("returns 404 when the team does not exist or belongs to another tenant", async () => {
    getReturnsRow = false;
    expect((await putMembers(["u-1"])).status).toBe(404);
    expect(mockReplaceMembers).not.toHaveBeenCalled();
  });

  it("returns 403 for agent role (member edits are admin-only)", async () => {
    mockAuth.roles = ["agent"];
    expect((await putMembers(["u-1"])).status).toBe(403);
  });
});

describe("team members — review follow-ups", () => {
  it("does not re-check people who are already on the team", async () => {
    // u-gone lost their on-call role after joining; resubmitting them must not block the edit
    orgRoles = new Map([["u-1", ["agent"]]]);
    memberRows = [
      { teamId: mockTeamRow.id, userId: "u-gone", position: 0 },
      { teamId: mockTeamRow.id, userId: "u-1", position: 1 },
    ];
    expect((await putMembers(["u-gone", "u-1"])).status).toBe(200);
  });

  it("still checks a person being added", async () => {
    orgRoles = new Map([["u-1", ["agent"]]]);
    memberRows = [{ teamId: mockTeamRow.id, userId: "u-gone", position: 0 }];
    const res = await putMembers(["u-gone", "u-customer"]);
    expect(res.status).toBe(422);
    expect((await res.json()).fields[0].field).toBe("memberUserIds[1]");
  });

  it("refuses with 409 when someone skipped by the pre-check left the team before the write", async () => {
    // u-gone was on the team when the pre-check ran (so was not re-checked), then was removed
    orgRoles = new Map([["u-1", ["agent"]]]);
    memberRows = [{ teamId: mockTeamRow.id, userId: "u-gone", position: 0 }];
    lockedMembers = [];
    const res = await putMembers(["u-gone", "u-1"]);
    expect(res.status).toBe(409);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("refuses someone who is already on another team, naming the team", async () => {
    orgRoles = new Map([["u-1", ["agent"]]]);
    takenElsewhere = [{ userId: "u-1", teamName: "Support" }];
    const res = await putMembers(["u-1"]);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields[0].field).toBe("memberUserIds[0]");
    expect(body.fields[0].message).toMatch(/Support/);
  });

  it("answers 404 for a missing team without asking Zitadel", async () => {
    getReturnsRow = false;
    expect((await putMembers(["u-1"])).status).toBe(404);
    expect(rolesLookups).toBe(0);
  });

  it("removes the members of a soft-deleted team", async () => {
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(deleteCalls).toBe(1);
  });
});
