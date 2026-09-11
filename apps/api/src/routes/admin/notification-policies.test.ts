import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const { mockAuth, mockWriteAuditEntry } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
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

const notificationPoliciesTable = { __name: "notification_policies" };
const workflowsTable = { __name: "workflows" };
const onCallSchedulesTable = { __name: "on_call_schedules" };
const tenantUsersTable = { __name: "tenant_users" };

const mockPolicyRow = {
  id: "22222222-2222-4222-8222-222222222222",
  tenantId: "t-aaa",
  teamId: null,
  workflowTypeId: null,
  severity: "high",
  channels: ["email"],
  notifyBackup: true,
  notifyEscalationManager: false,
  createdBy: "u-bbb",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

let teamRefValid = true;
let workflowRefValid = true;
let getReturnsRow = true;
let insertShouldConflict = false;
let updateShouldConflict = false;
let updateReturnsRow = true;
let deleteReturnsRow = true;
let resolveCandidates: (typeof mockPolicyRow)[] = [];
let activeScheduleFixture: {
  backupUserId: string | null;
  escalationManagerUserId: string | null;
} | null = null;
let tenantUsersFixture: {
  userId: string;
  displayName: string | null;
  email: string | null;
}[] = [];

vi.mock("@platform/db", () => ({
  db: {},
  notificationPolicies: {
    id: "id",
    tenantId: "tenantId",
    teamId: "teamId",
    workflowTypeId: "workflowTypeId",
    severity: "severity",
    createdAt: "createdAt",
    deletedAt: "deletedAt",
    __table: notificationPoliciesTable,
  },
  teams: { id: "id", tenantId: "tenantId", deletedAt: "deletedAt" },
  workflows: { id: "id", tenantId: "tenantId", __table: workflowsTable },
  onCallSchedules: {
    id: "id",
    tenantId: "tenantId",
    teamId: "teamId",
    startsAt: "startsAt",
    endsAt: "endsAt",
    deletedAt: "deletedAt",
    backupUserId: "backupUserId",
    escalationManagerUserId: "escalationManagerUserId",
    __table: onCallSchedulesTable,
  },
  tenantUsers: {
    tenantId: "tenantId",
    userId: "userId",
    displayName: "displayName",
    email: "email",
    __table: tenantUsersTable,
  },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    let lastTable: unknown;
    const tx: Record<string, unknown> = {
      select: () => tx,
      from: (t: { __table?: unknown }) => {
        lastTable = t?.__table ?? t;
        return tx;
      },
      where: () => tx,
      orderBy: () => tx,
      limit: () => {
        if (lastTable === notificationPoliciesTable) {
          return Promise.resolve(getReturnsRow ? [mockPolicyRow] : []);
        }
        if (lastTable === onCallSchedulesTable) {
          return Promise.resolve(
            activeScheduleFixture ? [activeScheduleFixture] : [],
          );
        }
        return Promise.resolve([]);
      },
      then: (resolve: (v: unknown) => void) => {
        if (lastTable === notificationPoliciesTable) {
          return resolve(resolveCandidates);
        }
        if (lastTable === workflowsTable) {
          return resolve(
            workflowRefValid
              ? [{ id: "33333333-3333-4333-8333-333333333333" }]
              : [],
          );
        }
        if (lastTable === tenantUsersTable) {
          return resolve(tenantUsersFixture);
        }
        return resolve([]);
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
        return Promise.resolve([mockPolicyRow]);
      },
    };
    return fn(tx);
  },
}));

vi.mock("@platform/teams", () => ({
  lookupValidIdsInTable: () => async () =>
    teamRefValid
      ? new Set(["11111111-1111-4111-8111-111111111111"])
      : new Set(),
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
  lte: (...args: unknown[]) => ({ op: "lte", args }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  isNull: (...args: unknown[]) => ({ op: "isNull", args }),
  inArray: (...args: unknown[]) => ({ op: "inArray", args }),
}));

const { notificationPoliciesRouter } =
  await import("./notification-policies.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/admin/notification-policies", notificationPoliciesRouter);
  return app;
}

const TEAM_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  mockAuth.roles = ["admin"];
  teamRefValid = true;
  workflowRefValid = true;
  getReturnsRow = true;
  insertShouldConflict = false;
  updateShouldConflict = false;
  updateReturnsRow = true;
  deleteReturnsRow = true;
  resolveCandidates = [];
  activeScheduleFixture = null;
  tenantUsersFixture = [];
});

describe("GET /admin/notification-policies — role enforcement", () => {
  it("returns 200 for admin role", async () => {
    const res = await makeApp().request("/admin/notification-policies");
    expect(res.status).toBe(200);
  });

  it("returns 403 for agent role (list is admin-only, unlike labels)", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/notification-policies");
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/notification-policies/:id", () => {
  it("returns 200 with the policy when it exists", async () => {
    const res = await makeApp().request(
      `/admin/notification-policies/${mockPolicyRow.id}`,
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 when it does not exist", async () => {
    getReturnsRow = false;
    const res = await makeApp().request(
      `/admin/notification-policies/${mockPolicyRow.id}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/notification-policies", () => {
  it("returns 201 for a global policy (no teamId/workflowTypeId)", async () => {
    const res = await makeApp().request("/admin/notification-policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ severity: "high", channels: ["email"] }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 422 when teamId does not resolve within the tenant", async () => {
    teamRefValid = false;
    const res = await makeApp().request("/admin/notification-policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        severity: "high",
        channels: ["email"],
        teamId: TEAM_ID,
      }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 422 when workflowTypeId does not resolve within the tenant", async () => {
    workflowRefValid = false;
    const res = await makeApp().request("/admin/notification-policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        severity: "high",
        channels: ["email"],
        workflowTypeId: "33333333-3333-4333-8333-333333333333",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 400 for an unrecognized channel name", async () => {
    const res = await makeApp().request("/admin/notification-policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ severity: "high", channels: ["fax"] }),
    });
    expect(res.status).toBe(400);
  });

  // G1 (PR #594 review): a duplicate channel would dispatch the same
  // channel twice per notification.
  it("returns 400 for a duplicate channel", async () => {
    const res = await makeApp().request("/admin/notification-policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        severity: "high",
        channels: ["email", "email"],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the specificity slot is already taken", async () => {
    insertShouldConflict = true;
    const res = await makeApp().request("/admin/notification-policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ severity: "high", channels: ["email"] }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 403 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/notification-policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ severity: "high", channels: ["email"] }),
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /admin/notification-policies/:id", () => {
  it("returns 200 when the policy exists", async () => {
    const res = await makeApp().request(
      `/admin/notification-policies/${mockPolicyRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels: ["sms"] }),
      },
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 when the policy does not exist", async () => {
    updateReturnsRow = false;
    const res = await makeApp().request(
      `/admin/notification-policies/${mockPolicyRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels: ["sms"] }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 on a specificity-slot conflict", async () => {
    updateShouldConflict = true;
    const res = await makeApp().request(
      `/admin/notification-policies/${mockPolicyRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ severity: "critical" }),
      },
    );
    expect(res.status).toBe(409);
  });
});

describe("DELETE /admin/notification-policies/:id", () => {
  it("returns 204 on successful soft-delete", async () => {
    const res = await makeApp().request(
      `/admin/notification-policies/${mockPolicyRow.id}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);
  });

  it("returns 404 when it does not exist", async () => {
    deleteReturnsRow = false;
    const res = await makeApp().request(
      `/admin/notification-policies/${mockPolicyRow.id}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/notification-policies/resolve — agent-readable (R20)", () => {
  it("returns 200 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request(
      "/admin/notification-policies/resolve?severity=high",
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /admin/notification-policies/resolve", () => {
  it("returns the hardcoded default when no policy matches", async () => {
    resolveCandidates = [];
    const res = await makeApp().request(
      "/admin/notification-policies/resolve?severity=high",
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.matchedAt).toBe("hardcoded-default");
    expect(json.data.policyId).toBeNull();
    expect(json.data.channels).toEqual(["email"]);
  });

  it("picks the highest-specificity candidate (team+workflow over team-only)", async () => {
    resolveCandidates = [
      {
        ...mockPolicyRow,
        id: "global-policy",
        teamId: null,
        workflowTypeId: null,
      },
      {
        ...mockPolicyRow,
        id: "team-policy",
        teamId: TEAM_ID,
        workflowTypeId: null,
      },
      {
        ...mockPolicyRow,
        id: "team-workflow-policy",
        teamId: TEAM_ID,
        workflowTypeId: "33333333-3333-4333-8333-333333333333",
      },
    ];
    const res = await makeApp().request(
      `/admin/notification-policies/resolve?severity=high&teamId=${TEAM_ID}&workflowTypeId=33333333-3333-4333-8333-333333333333`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.policyId).toBe("team-workflow-policy");
    expect(json.data.matchedAt).toBe("team+workflow");
  });

  it("resolves backup/escalation recipients from the team's active on-call schedule", async () => {
    resolveCandidates = [
      {
        ...mockPolicyRow,
        id: "team-policy",
        teamId: TEAM_ID,
        notifyBackup: true,
        notifyEscalationManager: true,
      },
    ];
    activeScheduleFixture = {
      backupUserId: "u-backup",
      escalationManagerUserId: "u-escalation",
    };
    tenantUsersFixture = [
      { userId: "u-backup", displayName: "Backup Person", email: null },
      { userId: "u-escalation", displayName: null, email: "esc@example.com" },
    ];
    const res = await makeApp().request(
      `/admin/notification-policies/resolve?severity=high&teamId=${TEAM_ID}`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.recipients).toHaveLength(2);
    expect(json.data.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "backup", name: "Backup Person" }),
        expect.objectContaining({
          role: "escalationManager",
          name: "esc@example.com",
        }),
      ]),
    );
  });

  it("returns 400 when severity is missing", async () => {
    const res = await makeApp().request("/admin/notification-policies/resolve");
    expect(res.status).toBe(400);
  });

  // B2 (PR #594 review): a stale/typo'd/cross-tenant teamId must not
  // silently resolve to "no policies match" -- indistinguishable from a
  // genuinely valid team with no active schedule.
  it("returns 422 when teamId does not resolve within the tenant", async () => {
    teamRefValid = false;
    const res = await makeApp().request(
      `/admin/notification-policies/resolve?severity=high&teamId=${TEAM_ID}`,
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 422 when workflowTypeId does not resolve within the tenant", async () => {
    workflowRefValid = false;
    const res = await makeApp().request(
      "/admin/notification-policies/resolve?severity=high&workflowTypeId=33333333-3333-4333-8333-333333333333",
    );
    expect(res.status).toBe(422);
  });
});
