import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const { mockAuth, mockWriteAuditEntry, mockResolveTenantMembers, callOrder } =
  vi.hoisted(() => ({
    mockAuth: {
      tenantId: "t-aaa",
      userId: "u-bbb",
      orgId: "org-1",
      roles: ["admin"] as string[],
      email: "test@example.com",
    },
    mockWriteAuditEntry: vi.fn(),
    mockResolveTenantMembers:
      vi.fn<
        (
          tenantId: string,
          ids: string[],
          orgId: string | undefined,
        ) => Promise<Set<string>>
      >(),
    callOrder: [] as string[],
  }));

let orgRoles = new Map<string, string[]>();
let rolesLookupFails = false;

vi.mock("../../lib/zitadel-management.js", () => ({
  listUserRolesByUserId: () =>
    rolesLookupFails
      ? Promise.reject(new Error("zitadel unavailable"))
      : Promise.resolve(orgRoles),
}));

vi.mock("../../lib/ensure-user-refs.js", () => ({
  resolveTenantMembers: (
    tenantId: string,
    ids: string[],
    orgId: string | undefined,
  ) => {
    callOrder.push("resolveTenantMembers");
    return mockResolveTenantMembers(tenantId, ids, orgId);
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

const FUTURE_START = new Date(Date.now() + 24 * 60 * 60 * 1000);
const FUTURE_END = new Date(Date.now() + 48 * 60 * 60 * 1000);

const mockScheduleRow = {
  id: "33333333-3333-4333-8333-333333333333",
  tenantId: "t-aaa",
  teamId: "11111111-1111-4111-8111-111111111111",
  label: "Week 1",
  startsAt: FUTURE_START,
  endsAt: FUTURE_END,
  primaryUserId: "u-bbb",
  backupUserId: null,
  escalationManagerUserId: null,
  createdBy: "u-bbb",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

let overlapConflict = false;
let getReturnsRow = true;
let teamMemberIds: string[] = [];
let activeRotationExists = false;

vi.mock("@platform/teams", () => ({
  ROTATION_MIN_CYCLE_DAYS: 3,
  ROTATION_MAX_CYCLE_DAYS: 90,
  loadTeamMemberIds: () => Promise.resolve(teamMemberIds),
  validateCrossTenantRefs: async (
    refs: { fieldName: string; refId: string }[],
    lookup: (ids: string[]) => Promise<Set<string>>,
  ) => {
    const validIds = await lookup(refs.map((r) => r.refId));
    return refs
      .filter((r) => !validIds.has(r.refId))
      .map((r) => ({
        field: r.fieldName,
        code: "INVALID_REFERENCE",
        message: "Referenced resource does not exist or is not accessible",
        meta: { refId: r.refId },
      }));
  },
  // Distinguishes the team_id lookup (idColumn "id") from the user-ref
  // lookup (idColumn "userId", used by validateScheduleRefs' B4 fix) -- both
  // now go through this same mocked helper, so a single fixed Set would
  // wrongly reject "u-bbb" against the team_id's valid-id set.
  lookupValidIdsInTable:
    (_tx: unknown, _table: unknown, idColumn: string) => async () =>
      idColumn === "userId"
        ? new Set(["u-bbb"])
        : new Set(["11111111-1111-4111-8111-111111111111"]),
}));

vi.mock("@platform/db", () => ({
  // `db` (the raw, non-tenant-scoped client) is only used by requireAuth(db)
  // at router setup now -- all query logic runs through withTenantContext's
  // tx below, per the RLS-defense-in-depth fix.
  db: {},
  teams: { id: "id", tenantId: "tenantId", deletedAt: "deletedAt" },
  onCallRotations: {
    id: "id",
    tenantId: "tenantId",
    teamId: "teamId",
    status: "status",
    isRotations: true,
  },
  teamMembers: {
    tenantId: "tenantId",
    teamId: "teamId",
    userId: "memberUserId",
  },
  tenantUsers: {
    tenantId: "tenantId",
    userId: "userId",
    displayName: "displayName",
    email: "email",
  },
  onCallSchedules: {
    id: "id",
    tenantId: "tenantId",
    teamId: "teamId",
    startsAt: "startsAt",
    endsAt: "endsAt",
    deletedAt: "deletedAt",
  },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    callOrder.push("withTenantContext");
    let fromTable: unknown;
    const tx = {
      select: () => tx,
      from: (table: unknown) => {
        fromTable = table;
        return tx;
      },
      where: () => tx,
      orderBy: () => tx,
      limit: () =>
        Promise.resolve(
          (fromTable as { isRotations?: boolean } | undefined)?.isRotations
            ? activeRotationExists
              ? [{ id: "rot-existing" }]
              : []
            : getReturnsRow
              ? [mockScheduleRow]
              : [],
        ),
      insert: () => tx,
      values: () => tx,
      update: () => tx,
      set: () => tx,
      returning: () => {
        if (overlapConflict) {
          const err = new Error("overlapping range");
          (err as unknown as { cause: { code: string } }).cause = {
            code: "23P01",
          };
          throw err;
        }
        return Promise.resolve([mockScheduleRow]);
      },
      // Makes `await tx.select().from(tenantUsers).where(...)` resolve
      // directly (a chain that stops at .where() rather than continuing to
      // .limit()/.returning()) -- this is the tenantUsers cross-tenant-ref
      // lookup inside validateScheduleRefs, now run under this same tx per
      // the RLS-defense-in-depth fix (PR review). Other call sites move
      // past .where() to .limit()/.returning(), which return real Promises
      // and never trigger this.
      then: (resolve: (v: unknown) => void) =>
        resolve(
          (fromTable as { userId?: string } | undefined)?.userId ===
            "memberUserId"
            ? teamMemberIds.map((userId) => ({ userId }))
            : [{ userId: "u-bbb" }],
        ),
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
  eq: (...args: unknown[]) => ({ op: "eq", args }),
  gt: (...args: unknown[]) => ({ op: "gt", args }),
  gte: (...args: unknown[]) => ({ op: "gte", args }),
  lte: (...args: unknown[]) => ({ op: "lte", args }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  inArray: (...args: unknown[]) => ({ op: "inArray", args }),
  asc: (...args: unknown[]) => ({ op: "asc", args }),
  isNull: (...args: unknown[]) => ({ op: "isNull", args }),
}));

const { onCallSchedulesRouter } = await import("./on-call-schedules.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/admin/on-call-schedules", onCallSchedulesRouter);
  return app;
}

const validCreateBody = {
  teamId: "11111111-1111-4111-8111-111111111111",
  label: "Week 1",
  startsAt: FUTURE_START.toISOString(),
  endsAt: FUTURE_END.toISOString(),
  primaryUserId: "u-bbb",
};

// Reset shared mutable fixture flags before every test (module-level `let`s
// leak across describe blocks otherwise, per teams.test.ts's fix).
beforeEach(() => {
  mockAuth.roles = ["admin"];
  overlapConflict = false;
  getReturnsRow = true;
  teamMemberIds = [];
  activeRotationExists = false;
  mockWriteAuditEntry.mockReset();
  callOrder.length = 0;
  mockResolveTenantMembers.mockReset();
  mockResolveTenantMembers.mockResolvedValue(new Set());
  rolesLookupFails = false;
  orgRoles = new Map([
    ["u-bbb", ["admin"]],
    ["u-backup", ["user"]],
    ["u-manager", ["agent"]],
  ]);
});

describe("on-call schedule writes — people who haven't signed in yet", () => {
  it("records the picked people from the org before the write transaction opens", async () => {
    const res = await makeApp().request("/admin/on-call-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validCreateBody,
        backupUserId: "u-backup",
        escalationManagerUserId: "u-manager",
      }),
    });
    expect(res.status).toBe(422); // the mocked tenant_users only knows u-bbb
    expect(mockResolveTenantMembers).toHaveBeenCalledWith(
      "t-aaa",
      ["u-bbb", "u-backup", "u-manager"],
      "org-1",
    );
    expect(callOrder.slice(0, 2)).toEqual([
      "resolveTenantMembers",
      "withTenantContext",
    ]);
  });

  it("does the same on edit, and skips the lookup when no person changes", async () => {
    await makeApp().request(`/admin/on-call-schedules/${mockScheduleRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backupUserId: "u-bbb" }),
    });
    expect(mockResolveTenantMembers).toHaveBeenCalledWith(
      "t-aaa",
      ["u-bbb"],
      "org-1",
    );

    mockResolveTenantMembers.mockClear();
    const res = await makeApp().request(
      `/admin/on-call-schedules/${mockScheduleRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Renamed" }),
      },
    );
    expect(res.status).toBe(200);
    expect(mockResolveTenantMembers).not.toHaveBeenCalled();
  });

  it("refuses a person without an on-call role (platform admin or no role), naming each field", async () => {
    orgRoles = new Map([
      ["u-bbb", ["admin"]],
      ["u-platform", ["platform_admin"]],
    ]);
    const res = await makeApp().request("/admin/on-call-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validCreateBody,
        backupUserId: "u-platform",
        escalationManagerUserId: "u-norole",
      }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.fields).toEqual([
      { field: "backupUserId", message: expect.stringMatching(/on-call role/) },
      {
        field: "escalationManagerUserId",
        message: expect.stringMatching(/on-call role/),
      },
    ]);
    expect(mockResolveTenantMembers).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("withTenantContext");
  });

  it("refuses a signed-in person whose role isn't an on-call role (direct API call)", async () => {
    // u-bbb is in tenant_users (the mocked lookup) but now holds no on-call role.
    orgRoles = new Map([["u-bbb", ["platform_admin"]]]);
    const res = await makeApp().request(
      `/admin/on-call-schedules/${mockScheduleRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primaryUserId: "u-bbb" }),
      },
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.fields).toEqual([
      expect.objectContaining({ field: "primaryUserId" }),
    ]);
  });

  it("answers 503 when Zitadel can't be asked, without recording or writing", async () => {
    rolesLookupFails = true;
    const res = await makeApp().request("/admin/on-call-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validCreateBody),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("SERVICE_UNAVAILABLE");
    expect(mockResolveTenantMembers).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("withTenantContext");
  });

  it("still rejects a person who isn't in the org (422)", async () => {
    const res = await makeApp().request("/admin/on-call-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validCreateBody, primaryUserId: "u-outsider" }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.fields).toEqual([
      expect.objectContaining({ field: "primaryUserId" }),
    ]);
  });
});

describe("GET /admin/on-call-schedules — role enforcement", () => {
  it("returns 200 for admin role", async () => {
    const res = await makeApp().request("/admin/on-call-schedules");
    expect(res.status).toBe(200);
  });

  it("returns 403 for a role with neither agent nor admin", async () => {
    mockAuth.roles = ["user"];
    const res = await makeApp().request("/admin/on-call-schedules");
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/on-call-schedules/:id", () => {
  it("returns 200 with the schedule when it exists", async () => {
    const res = await makeApp().request(
      `/admin/on-call-schedules/${mockScheduleRow.id}`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(mockScheduleRow.id);
  });

  it("returns 404 when the schedule does not exist (or belongs to another tenant)", async () => {
    getReturnsRow = false;
    const res = await makeApp().request(
      `/admin/on-call-schedules/${mockScheduleRow.id}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/on-call-schedules", () => {
  it("returns 201 for a valid, non-overlapping window", async () => {
    const res = await makeApp().request("/admin/on-call-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validCreateBody),
    });
    expect(res.status).toBe(201);
  });

  it("returns 422 when startsAt >= endsAt", async () => {
    const res = await makeApp().request("/admin/on-call-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validCreateBody,
        startsAt: FUTURE_END.toISOString(),
        endsAt: FUTURE_START.toISOString(),
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the window overlaps an existing schedule for the team (R5)", async () => {
    overlapConflict = true;
    const res = await makeApp().request("/admin/on-call-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validCreateBody),
    });
    expect(res.status).toBe(409);
  });

  it("returns 403 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/on-call-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validCreateBody),
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /admin/on-call-schedules/:id — future-window-only (R5)", () => {
  it("returns 200 when the schedule's window has not started yet", async () => {
    const res = await makeApp().request(
      `/admin/on-call-schedules/${mockScheduleRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Renamed" }),
      },
    );
    expect(res.status).toBe(200);
  });
});

describe("DELETE /admin/on-call-schedules/:id", () => {
  it("returns 204 on successful soft-delete", async () => {
    const res = await makeApp().request(
      `/admin/on-call-schedules/${mockScheduleRow.id}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);
  });

  it("returns 403 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request(
      `/admin/on-call-schedules/${mockScheduleRow.id}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(403);
  });
});

describe("on-call schedule writes — roles come from the team's members (oncall-team-rotation R3)", () => {
  const url = `/admin/on-call-schedules/${mockScheduleRow.id}`;
  const post = (body: object): Promise<Response> =>
    makeApp().request("/admin/on-call-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const patch = (body: object): Promise<Response> =>
    makeApp().request(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("creates a window when the primary is a member of the team", async () => {
    teamMemberIds = ["u-bbb", "u-other"];
    expect((await post(validCreateBody)).status).toBe(201);
  });

  it("refuses a primary who is not a member, naming the field", async () => {
    teamMemberIds = ["u-other"];
    const res = await post(validCreateBody);
    expect(res.status).toBe(422);
    expect((await res.json()).fields).toEqual([
      {
        field: "primaryUserId",
        message: expect.stringMatching(/member of the selected team/),
      },
    ]);
  });

  it("keeps the old any-eligible-user behaviour for a team with no members", async () => {
    teamMemberIds = [];
    expect((await post(validCreateBody)).status).toBe(201);
  });

  it("refuses a backup who is not a member when the edit changes the backup", async () => {
    teamMemberIds = ["u-other"];
    const res = await patch({ backupUserId: "u-bbb" });
    expect(res.status).toBe(422);
    expect((await res.json()).fields[0].field).toBe("backupUserId");
  });

  it("lets an edit that changes no role pass even when the holder left the team", async () => {
    teamMemberIds = ["u-other"];
    expect((await patch({ label: "Renamed" })).status).toBe(200);
    // primary resent unchanged (the roster form sends all three)
    expect(
      (await patch({ label: "Renamed", primaryUserId: "u-bbb" })).status,
    ).toBe(200);
  });
});

describe("on-call schedule create — repeat (oncall-team-rotation R4)", () => {
  const post = (body: object): Promise<Response> =>
    makeApp().request("/admin/on-call-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("creates the first window and a rotation for a team with members", async () => {
    teamMemberIds = ["u-bbb", "u-other"];
    const res = await post({ ...validCreateBody, repeat: { cycleDays: 7 } });
    expect(res.status).toBe(201);
    const actions = mockWriteAuditEntry.mock.calls.map(
      (c) => (c[1] as { resourceType: string }).resourceType,
    );
    expect(actions).toEqual(["on_call_rotation", "on_call_schedule"]);
  });

  it("creates only a window when repeat is off (nothing changes from today)", async () => {
    teamMemberIds = ["u-bbb"];
    expect((await post(validCreateBody)).status).toBe(201);
    const types = mockWriteAuditEntry.mock.calls.map(
      (c) => (c[1] as { resourceType: string }).resourceType,
    );
    expect(types).toEqual(["on_call_schedule"]);
  });

  it("refuses a repeating roster for a team with no members", async () => {
    teamMemberIds = [];
    const res = await post({ ...validCreateBody, repeat: { cycleDays: 7 } });
    expect(res.status).toBe(422);
    expect((await res.json()).fields).toEqual([
      expect.objectContaining({ field: "repeat" }),
    ]);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns 409 when the team already has an active rotation", async () => {
    teamMemberIds = ["u-bbb"];
    activeRotationExists = true;
    const res = await post({ ...validCreateBody, repeat: { cycleDays: 7 } });
    expect(res.status).toBe(409);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("rejects a cycle outside 3 to 90 days with 400", async () => {
    for (const cycleDays of [2, 91, 7.5, 0]) {
      const res = await post({ ...validCreateBody, repeat: { cycleDays } });
      expect(res.status).toBe(400);
    }
  });
});
