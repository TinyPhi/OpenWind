import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const { mockAuth, mockWriteAuditEntry } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-admin",
    orgId: "org-1",
    roles: ["admin"] as string[],
    email: "test@example.com",
  },
  mockWriteAuditEntry: vi.fn(),
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

const ROTATION_ID = "44444444-4444-4444-8444-444444444444";
const rotationRow = {
  id: ROTATION_ID,
  tenantId: "t-aaa",
  teamId: "11111111-1111-4111-8111-111111111111",
  cycleDays: 7,
  status: "active",
  endsOn: null,
  blockedReason: null as string | null,
  nextStartsAt: new Date("2026-11-09T00:00:00Z"),
  lastPrimaryUserId: "u-1",
  lastBackupUserId: "u-2",
  escalationManagerUserId: "u-3",
  createdBy: "u-admin",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  updatedAt: new Date("2026-11-01T00:00:00Z"),
};

let found = true;
let existingRow = { ...rotationRow };
let members: string[] = ["u-1", "u-2", "u-3"];
let updateConflict = false;
let teamDeleted = false;
let updatedPatch: Record<string, unknown> | null = null;
let upcomingWindows: Array<{
  id: string;
  label: string;
  startsAt: Date;
  endsAt: Date;
}> = [];
let deletedTables: unknown[] = [];
let lockModes: string[] = [];

vi.mock("@platform/db", () => ({
  db: {},
  onCallRotations: {
    id: "id",
    tenantId: "tenantId",
    teamId: "teamId",
    createdAt: "createdAt",
  },
  onCallSchedules: {
    id: "sid",
    tenantId: "stenantId",
    rotationId: "srotationId",
    startsAt: "sstartsAt",
    label: "slabel",
    endsAt: "sendsAt",
  },
  onCallScheduleNotices: {
    tenantId: "ntenantId",
    scheduleId: "nscheduleId",
  },
  teams: { id: "id", tenantId: "tenantId", deletedAt: "deletedAt" },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    let fromTable: unknown;
    const tx = {
      select: () => tx,
      from: (table: unknown) => {
        fromTable = table;
        return tx;
      },
      where: () => tx,
      // awaiting a bare select(...).where(...) is the "upcoming windows" query
      then: (resolve: (rows: unknown) => unknown) => resolve(upcomingWindows),
      delete: (table: unknown) => {
        deletedTables.push(table);
        return tx;
      },
      orderBy: () =>
        Object.assign(Promise.resolve(found ? [existingRow] : []), {
          limit: () => Promise.resolve(found ? [existingRow] : []),
        }),
      limit: () =>
        Object.assign(
          Promise.resolve(
            (fromTable as { deletedAt?: string } | undefined)?.deletedAt &&
              teamDeleted
              ? []
              : found
                ? [existingRow]
                : [],
          ),
          {
            for: (mode: string) => {
              lockModes.push(mode);
              return Promise.resolve(found ? [existingRow] : []);
            },
          },
        ),
      update: () => tx,
      set: (patch: Record<string, unknown>) => {
        updatedPatch = patch;
        return tx;
      },
      returning: () => {
        if (updateConflict) {
          const err = new Error("duplicate key");
          (err as unknown as { cause: { code: string } }).cause = {
            code: "23505",
          };
          throw err;
        }
        return Promise.resolve([{ ...existingRow, ...updatedPatch }]);
      },
    };
    return fn(tx);
  },
}));

vi.mock("@platform/teams", () => ({
  loadTeamMemberIds: () => Promise.resolve(members),
  loadPreviousHolders: () => Promise.resolve({ primary: "u-1", backup: "u-2" }),
  projectWindows: (input: { count: number }) =>
    Array.from({ length: Math.min(input.count, 2) }, (_, i) => ({
      startsAt: new Date(Date.UTC(2026, 10, 9 + i * 7)),
      endsAt: new Date(Date.UTC(2026, 10, 16 + i * 7)),
      primary: "u-2",
      backup: "u-3",
      escalationManager: "u-3",
    })),
  nextAssignment: (m: string[]) =>
    m.length === 0 ? null : { primary: "u-2", backup: "u-3" },
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
  desc: (...args: unknown[]) => ({ op: "desc", args }),
  isNull: (...args: unknown[]) => ({ op: "isNull", args }),
  gt: (...args: unknown[]) => ({ op: "gt", args }),
  ne: (...args: unknown[]) => ({ op: "ne", args }),
  inArray: (...args: unknown[]) => ({ op: "inArray", args }),
}));

const { onCallRotationsRouter } = await import("./on-call-rotations.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/admin/on-call-rotations", onCallRotationsRouter);
  return app;
}

function patch(body: unknown): Promise<Response> {
  return makeApp().request(`/admin/on-call-rotations/${ROTATION_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockAuth.roles = ["admin"];
  found = true;
  existingRow = { ...rotationRow };
  members = ["u-1", "u-2", "u-3"];
  updateConflict = false;
  upcomingWindows = [];
  deletedTables = [];
  lockModes = [];
  teamDeleted = false;
  updatedPatch = null;
  mockWriteAuditEntry.mockReset();
});

describe("GET /admin/on-call-rotations", () => {
  it("lists rotations with who is next, readable by agents", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/on-call-rotations");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data[0]).toMatchObject({
      id: ROTATION_ID,
      status: "active",
      blocked: false,
      nextPrimaryUserId: "u-2",
      nextBackupUserId: "u-3",
      cycleDays: 7,
    });
  });

  it("reports an active rotation with a reason as blocked", async () => {
    existingRow = { ...rotationRow, blockedReason: "overlaps a manual window" };
    const { data } = await (
      await makeApp().request("/admin/on-call-rotations")
    ).json();
    expect(data[0]).toMatchObject({
      blocked: true,
      blockedReason: "overlaps a manual window",
    });
  });

  it("does not call a stopped rotation blocked", async () => {
    existingRow = {
      ...rotationRow,
      status: "stopped",
      blockedReason: "old reason",
    };
    const { data } = await (
      await makeApp().request("/admin/on-call-rotations")
    ).json();
    expect(data[0].blocked).toBe(false);
  });

  it("returns 403 for a plain user", async () => {
    mockAuth.roles = ["user"];
    expect((await makeApp().request("/admin/on-call-rotations")).status).toBe(
      403,
    );
  });
});

describe("PATCH /admin/on-call-rotations/:id", () => {
  it("locks the rotation row before reading it, so the audit snapshot is not stale", async () => {
    const res = await patch({ status: "stopped" });
    expect(res.status).toBe(200);
    expect(lockModes).toEqual(["update"]);
  });

  it("stops a rotation and audits the change", async () => {
    const res = await patch({ status: "stopped" });
    expect(res.status).toBe(200);
    expect(updatedPatch).toMatchObject({ status: "stopped" });
    expect(mockWriteAuditEntry.mock.calls[0]?.[1]).toMatchObject({
      resourceType: "on_call_rotation",
      action: "updated",
      beforeSnapshot: { status: "active" },
      afterSnapshot: { status: "stopped" },
    });
  });

  it("lists projected windows for a running rotation and none for a paused one", async () => {
    const running = (await (await patch({ endsOn: null })).json()) as {
      data: { projected: unknown[] };
    };
    expect(running.data.projected).toHaveLength(2);
    expect(running.data.projected[0]).toMatchObject({
      primaryUserId: "u-2",
      backupUserId: "u-3",
    });
    existingRow = { ...rotationRow, status: "stopped" };
    const paused = (await (await patch({ endsOn: null })).json()) as {
      data: { projected: unknown[] };
    };
    expect(paused.data.projected).toEqual([]);
  });

  it("pausing removes the windows that have not started and rewinds the cursor", async () => {
    upcomingWindows = [
      {
        id: "w-2",
        label: "Rotation 2",
        startsAt: new Date("2026-11-16T00:00:00Z"),
        endsAt: new Date("2026-11-23T00:00:00Z"),
      },
      {
        id: "w-1",
        label: "Rotation 1",
        startsAt: new Date("2026-11-09T00:00:00Z"),
        endsAt: new Date("2026-11-16T00:00:00Z"),
      },
    ];
    const res = await patch({ status: "stopped" });
    expect(res.status).toBe(200);
    expect(deletedTables).toHaveLength(2); // notices, then windows
    expect(updatedPatch).toMatchObject({
      nextStartsAt: new Date("2026-11-09T00:00:00Z"),
    });
    const deletedAudits = mockWriteAuditEntry.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .filter((a) => a.action === "deleted");
    expect(deletedAudits.map((a) => a.resourceId)).toEqual(["w-2", "w-1"]);
  });

  it("resuming never removes windows", async () => {
    existingRow = { ...rotationRow, status: "stopped" };
    upcomingWindows = [
      {
        id: "w-1",
        label: "Rotation 1",
        startsAt: new Date("2026-11-09T00:00:00Z"),
        endsAt: new Date("2026-11-16T00:00:00Z"),
      },
    ];
    expect((await patch({ status: "active" })).status).toBe(200);
    expect(deletedTables).toHaveLength(0);
  });

  it("sets and clears the end date", async () => {
    expect((await patch({ endsOn: "2026-12-31" })).status).toBe(200);
    expect(updatedPatch).toMatchObject({ endsOn: "2026-12-31" });
    expect((await patch({ endsOn: null })).status).toBe(200);
    expect(updatedPatch).toMatchObject({ endsOn: null });
  });

  it("resumes a stopped rotation, clearing the old blocked reason", async () => {
    existingRow = {
      ...rotationRow,
      status: "stopped",
      blockedReason: "old",
    };
    const res = await patch({ status: "active" });
    expect(res.status).toBe(200);
    expect(updatedPatch).toMatchObject({
      status: "active",
      blockedReason: null,
    });
  });

  it("refuses to resume when the team has no members", async () => {
    existingRow = { ...rotationRow, status: "stopped" };
    members = [];
    const res = await patch({ status: "active" });
    expect(res.status).toBe(422);
    expect((await res.json()).fields[0].field).toBe("status");
    expect(updatedPatch).toBeNull();
  });

  it("refuses to resume when the team has been deleted", async () => {
    existingRow = { ...rotationRow, status: "stopped" };
    teamDeleted = true;
    const res = await patch({ status: "active" });
    expect(res.status).toBe(422);
    expect((await res.json()).fields[0].message).toMatch(/deleted/);
    expect(updatedPatch).toBeNull();
  });

  it("returns 409 when the team already has another active rotation", async () => {
    existingRow = { ...rotationRow, status: "stopped" };
    updateConflict = true;
    expect((await patch({ status: "active" })).status).toBe(409);
  });

  it("returns 404 for an unknown rotation or another tenant's", async () => {
    found = false;
    expect((await patch({ status: "stopped" })).status).toBe(404);
  });

  it("returns 400 for an empty body or a bad date", async () => {
    expect((await patch({})).status).toBe(400);
    expect((await patch({ endsOn: "next friday" })).status).toBe(400);
    expect((await patch({ status: "paused" })).status).toBe(400);
  });

  it("returns 403 for agents (admin only)", async () => {
    mockAuth.roles = ["agent"];
    expect((await patch({ status: "stopped" })).status).toBe(403);
  });
});

describe("DELETE /admin/on-call-rotations/:id", () => {
  const del = (): Promise<Response> =>
    makeApp().request(`/admin/on-call-rotations/${ROTATION_ID}`, {
      method: "DELETE",
    });

  it("stops the rotation and audits it", async () => {
    const res = await del();
    expect(res.status).toBe(204);
    expect(updatedPatch).toMatchObject({ status: "stopped" });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for an already stopped rotation", async () => {
    existingRow = { ...rotationRow, status: "stopped" };
    expect((await del()).status).toBe(204);
    expect(updatedPatch).toBeNull();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns 404 when it does not exist", async () => {
    found = false;
    expect((await del()).status).toBe(404);
  });

  it("returns 403 for agents", async () => {
    mockAuth.roles = ["agent"];
    expect((await del()).status).toBe(403);
  });
});
