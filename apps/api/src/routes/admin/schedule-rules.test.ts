import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as Scheduler from "@platform/scheduler";

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

const scheduleRulesTable = { __name: "schedule_rules" };
const scheduleExecutionsTable = { __name: "schedule_executions" };

const mockRuleRow = {
  id: "44444444-4444-4444-8444-444444444444",
  tenantId: "t-aaa",
  name: "Monthly Review",
  description: null,
  cronExpr: "0 9 25 * *",
  timezone: "UTC",
  entityTypeId: "55555555-5555-4555-8555-555555555555",
  workflowId: null,
  template: { title: "Review" },
  status: "active",
  nextFireAt: new Date("2026-10-25T09:00:00Z"),
  lastFiredAt: null,
  catchUp: false,
  createdBy: "u-bbb",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

let getReturnsRow = true;
let insertShouldConflict = false;
let refsValid = true;
let existingRuleOverride: typeof mockRuleRow | null = null;

vi.mock("@platform/db", () => ({
  db: {},
  scheduleRules: {
    id: "id",
    tenantId: "tenantId",
    name: "name",
    status: "status",
    createdAt: "createdAt",
    deletedAt: "deletedAt",
    entityTypeId: "entityTypeId",
    workflowId: "workflowId",
    __table: scheduleRulesTable,
  },
  scheduleExecutions: {
    id: "id",
    tenantId: "tenantId",
    ruleId: "ruleId",
    scheduledAt: "scheduledAt",
    status: "status",
    entityInstanceId: "entityInstanceId",
    errorCode: "errorCode",
    __table: scheduleExecutionsTable,
  },
  entityInstances: { id: "id", fields: "fields" },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    let lastTable: unknown;
    const tx: Record<string, unknown> = {
      select: () => tx,
      from: (t: { __table?: unknown }) => {
        lastTable = t?.__table ?? t;
        return tx;
      },
      leftJoin: () => tx,
      where: () => tx,
      orderBy: () => tx,
      limit: () => {
        if (lastTable === scheduleRulesTable) {
          const row = existingRuleOverride ?? mockRuleRow;
          return Promise.resolve(getReturnsRow ? [row] : []);
        }
        return Promise.resolve([]);
      },
      then: (resolve: (v: unknown) => void) => resolve([]),
      insert: () => tx,
      values: () => tx,
      update: () => tx,
      set: () => tx,
      returning: () => {
        if (insertShouldConflict) {
          const err = new Error("duplicate key");
          (err as unknown as { cause: { code: string } }).cause = {
            code: "23505",
          };
          throw err;
        }
        return Promise.resolve(
          getReturnsRow ? [existingRuleOverride ?? mockRuleRow] : [],
        );
      },
    };
    return fn(tx);
  },
}));

vi.mock("@platform/scheduler", async (importOriginal) => {
  const real = await importOriginal<typeof Scheduler>();
  return {
    ...real,
    isValidTimezone: vi.fn(() => true),
    validateCronExpr: vi.fn(),
    computeNextFireAt: vi.fn(() => new Date("2026-10-25T09:00:00Z")),
    getNextFires: vi.fn(() => [
      { utc: "2026-10-25T09:00:00.000Z", local: "2026-10-25T09:00:00.000Z" },
    ]),
    describeCronExpr: vi.fn(() => "At 09:00 on day-of-month 25"),
    validateScheduleRuleRefs: vi.fn(() =>
      Promise.resolve(
        refsValid
          ? []
          : [{ field: "entityTypeId", message: "invalid reference" }],
      ),
    ),
  };
});

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
  lt: (...args: unknown[]) => ({ op: "lt", args }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  isNull: (...args: unknown[]) => ({ op: "isNull", args }),
  desc: (...args: unknown[]) => ({ op: "desc", args }),
}));

const { scheduleRulesRouter } = await import("./schedule-rules.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/admin/schedule-rules", scheduleRulesRouter);
  return app;
}

const validBody = {
  name: "Monthly Review",
  cronExpr: "0 9 25 * *",
  timezone: "UTC",
  entityTypeId: mockRuleRow.entityTypeId,
  template: { title: "Review" },
};

beforeEach(() => {
  mockAuth.roles = ["admin"];
  getReturnsRow = true;
  insertShouldConflict = false;
  refsValid = true;
  existingRuleOverride = null;
});

describe("GET /admin/schedule-rules — role enforcement", () => {
  it("returns 200 for admin role", async () => {
    const res = await makeApp().request("/admin/schedule-rules");
    expect(res.status).toBe(200);
  });

  it("returns 403 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/schedule-rules");
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/schedule-rules/:id", () => {
  it("returns 200 with the rule (including cronHuman) when it exists", async () => {
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.cronHuman).toBe("At 09:00 on day-of-month 25");
  });

  it("returns 404 when it does not exist", async () => {
    getReturnsRow = false;
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/schedule-rules", () => {
  it("returns 201 for a valid body", async () => {
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "created" }),
    );
  });

  it("returns 422 when the timezone is invalid", async () => {
    const { isValidTimezone } = await import("@platform/scheduler");
    vi.mocked(isValidTimezone).mockReturnValueOnce(false);
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.fields[0].field).toBe("timezone");
  });

  it("returns 422 when the cron expression is invalid", async () => {
    const { validateCronExpr, InvalidCronExpressionError } =
      await import("@platform/scheduler");
    vi.mocked(validateCronExpr).mockImplementationOnce(() => {
      throw new InvalidCronExpressionError("bad", new Error("parse error"));
    });
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.fields[0].field).toBe("cronExpr");
  });

  it("returns 422 when cross-tenant refs are invalid", async () => {
    refsValid = false;
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(422);
  });

  it("returns 409 when the name is already taken", async () => {
    insertShouldConflict = true;
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(409);
  });

  it("returns 403 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /admin/schedule-rules/:id — status transitions", () => {
  it("pauses an active rule and audits schedule.rule_paused", async () => {
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "paused" }),
      },
    );
    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "schedule.rule_paused" }),
    );
  });

  it("resumes a paused rule and audits schedule.rule_resumed", async () => {
    existingRuleOverride = {
      ...mockRuleRow,
      status: "paused",
      nextFireAt: null,
    };
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      },
    );
    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "schedule.rule_resumed" }),
    );
  });

  it("archives a rule and audits schedule.rule_archived", async () => {
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      },
    );
    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "schedule.rule_archived" }),
    );
  });

  it("returns 409 when trying to un-archive an archived rule", async () => {
    existingRuleOverride = { ...mockRuleRow, status: "archived" };
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      },
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 when the rule does not exist", async () => {
    getReturnsRow = false;
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin/schedule-rules/:id", () => {
  it("returns 204 on successful soft-delete", async () => {
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);
  });

  it("returns 404 when it does not exist", async () => {
    getReturnsRow = false;
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/schedule-rules/:id/executions", () => {
  it("returns 200 with an empty execution list", async () => {
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}/executions`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });

  it("returns 404 when the rule does not exist", async () => {
    getReturnsRow = false;
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}/executions`,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/schedule-rules/:id/next-fires", () => {
  it("returns 200 with the dry-run fires, no DB write", async () => {
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}/next-fires?count=1`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.fires).toHaveLength(1);
    expect(json.data.timezone).toBe("UTC");
  });

  it("returns 404 when the rule does not exist", async () => {
    getReturnsRow = false;
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}/next-fires`,
    );
    expect(res.status).toBe(404);
  });
});
