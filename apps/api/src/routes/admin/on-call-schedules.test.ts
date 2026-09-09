import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["admin"] as string[],
    email: "test@example.com",
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

vi.mock("@platform/teams", () => ({
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
  lookupValidIdsInTable: () => async () =>
    new Set(["11111111-1111-4111-8111-111111111111"]),
}));

vi.mock("@platform/db", () => ({
  // `db` (the raw, non-tenant-scoped client) is only used by requireAuth(db)
  // at router setup now -- all query logic runs through withTenantContext's
  // tx below, per the RLS-defense-in-depth fix.
  db: {},
  teams: { id: "id", tenantId: "tenantId", deletedAt: "deletedAt" },
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
    const tx = {
      select: () => tx,
      from: () => tx,
      where: () => tx,
      orderBy: () => tx,
      limit: () => Promise.resolve([mockScheduleRow]),
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
      then: (resolve: (v: unknown) => void) => resolve([{ userId: "u-bbb" }]),
    };
    return fn(tx);
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (...args: unknown[]) => ({ op: "eq", args }),
  gt: (...args: unknown[]) => ({ op: "gt", args }),
  gte: (...args: unknown[]) => ({ op: "gte", args }),
  lte: (...args: unknown[]) => ({ op: "lte", args }),
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
