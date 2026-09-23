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
const entityTypesTable = { __name: "entity_types" };
const workflowsTable = { __name: "workflows" };

const mockRuleRow = {
  id: "44444444-4444-4444-8444-444444444444",
  tenantId: "t-aaa",
  name: "Monthly Review",
  description: null,
  cronExpr: "0 9 25 * *",
  timezone: "UTC",
  entityTypeId: "55555555-5555-4555-8555-555555555555",
  workflowId: null,
  template: {
    title: "Review",
    teamId: "66666666-6666-4666-8666-666666666666",
    due_days: 2,
    remark: "Auto-created by the monthly review rule.",
  },
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
// Controls resolveTicketEntityTypeId's DB lookup (POST without an explicit
// entityTypeId) -- defaults to resolving, matching mockRuleRow's own id so
// existing "explicit entityTypeId" tests don't have to care about this path.
let resolvedTicketEntityTypeId: string | null = mockRuleRow.entityTypeId;
// Controls resolveEntityTypeId's workflow lookup (POST/PATCH with a
// workflowId and no explicit entityTypeId) -- null means "workflow not
// found," which falls through to the ticket-type fallback above.
let resolvedWorkflowEntityTypeId: string | null = null;
let lastSetValues: Record<string, unknown> | null = null;

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
  entityTypes: {
    id: "id",
    name: "name",
    tenantId: "tenantId",
    __table: entityTypesTable,
  },
  workflows: {
    id: "id",
    entityTypeId: "entityTypeId",
    tenantId: "tenantId",
    __table: workflowsTable,
  },
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
        if (lastTable === entityTypesTable) {
          return Promise.resolve(
            resolvedTicketEntityTypeId
              ? [{ id: resolvedTicketEntityTypeId }]
              : [],
          );
        }
        if (lastTable === workflowsTable) {
          return Promise.resolve(
            resolvedWorkflowEntityTypeId
              ? [{ entityTypeId: resolvedWorkflowEntityTypeId }]
              : [],
          );
        }
        return Promise.resolve([]);
      },
      then: (resolve: (v: unknown) => void) => resolve([]),
      insert: () => tx,
      values: (values: Record<string, unknown>) => {
        lastSetValues = values;
        return tx;
      },
      update: () => tx,
      set: (values: Record<string, unknown>) => {
        lastSetValues = values;
        return tx;
      },
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
  template: mockRuleRow.template,
};

beforeEach(() => {
  mockAuth.roles = ["admin"];
  getReturnsRow = true;
  insertShouldConflict = false;
  refsValid = true;
  existingRuleOverride = null;
  resolvedTicketEntityTypeId = mockRuleRow.entityTypeId;
  resolvedWorkflowEntityTypeId = null;
  lastSetValues = null;
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

  // 2026-09-22 incident: the client used to guess entityTypeId itself
  // (name === "ticket" against a possibly-paginated list) and could send
  // the wrong one -- entityTypeId is now optional on the wire; the server
  // resolves the tenant's "ticket" entity type itself when it's omitted.
  it("resolves entityTypeId server-side (to the tenant's ticket entity type) when the client omits it", async () => {
    const { entityTypeId: _omitted, ...bodyWithoutEntityType } = validBody;
    resolvedTicketEntityTypeId = "77777777-7777-4777-8777-777777777777";
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyWithoutEntityType),
    });
    expect(res.status).toBe(201);
  });

  it("returns 422 when entityTypeId is omitted and the tenant has no ticket entity type", async () => {
    const { entityTypeId: _omitted, ...bodyWithoutEntityType } = validBody;
    resolvedTicketEntityTypeId = null;
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyWithoutEntityType),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.fields[0].field).toBe("entityTypeId");
  });

  // 2026-09-22 direction change: a schedule rule's entity type follows
  // whichever workflow it targets, the same way manual creation via
  // record-create.tsx is not restricted to "ticket" -- the "must be ticket"
  // restriction previously enforced here is gone.
  it("derives entityTypeId from the selected workflow's own entity type when entityTypeId is omitted", async () => {
    const { entityTypeId: _omitted, ...bodyWithoutEntityType } = validBody;
    resolvedWorkflowEntityTypeId = "88888888-8888-4888-8888-888888888888";
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...bodyWithoutEntityType,
        workflowId: "99999999-9999-4999-9999-999999999999",
      }),
    });
    expect(res.status).toBe(201);
    expect(lastSetValues?.["entityTypeId"]).toBe(
      "88888888-8888-4888-8888-888888888888",
    );
  });

  it("falls back to the tenant's ticket entity type when no workflow is selected at all", async () => {
    const { entityTypeId: _omitted, ...bodyWithoutEntityType } = validBody;
    resolvedTicketEntityTypeId = "77777777-7777-4777-8777-777777777777";
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyWithoutEntityType),
    });
    expect(res.status).toBe(201);
    expect(lastSetValues?.["entityTypeId"]).toBe(
      "77777777-7777-4777-8777-777777777777",
    );
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

  // These 3 fail TemplateSchema itself (the zValidator("json", ...) body
  // check), not the route's own manual 422 checks below it -- @hono/zod-
  // validator's default hook returns 400 for a body-schema failure (see
  // apps/api/src/lib/validator.ts's own comment), distinct from this
  // route's manual isValidTimezone/validateCronExpr/validateScheduleRuleRefs
  // checks, which construct their own 422 response by hand.
  it("returns 400 when template has both assignedTo and teamId (docs/specs/schedule-rules-mandate-fields.md R1)", async () => {
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        template: {
          ...validBody.template,
          assignedTo: "77777777-7777-4777-8777-777777777777",
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when template has neither assignedTo nor teamId", async () => {
    const { teamId: _teamId, ...templateWithoutTeam } = validBody.template;
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, template: templateWithoutTeam }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when template is missing remark or due_days", async () => {
    const { remark: _remark, due_days: _dueDays, ...rest } = validBody.template;
    const res = await makeApp().request("/admin/schedule-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, template: rest }),
    });
    expect(res.status).toBe(400);
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

  // 2026-09-22 real-world repro: a rule's workflow changed via PATCH to one
  // belonging to a different entity type -- entityTypeId must follow it, or
  // the rule ends up creating entities of the wrong type for its new
  // workflow (invisible under that workflow's own records list).
  it("re-resolves entityTypeId to match a new workflow when workflowId changes", async () => {
    resolvedWorkflowEntityTypeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(lastSetValues?.["entityTypeId"]).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });

  it("leaves entityTypeId untouched when workflowId is not part of the update", async () => {
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      },
    );
    expect(res.status).toBe(200);
    expect(lastSetValues?.["entityTypeId"]).toBeUndefined();
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

  // PR #595 review, B1: deliberately NOT filtered by isNull(deletedAt) --
  // execution history must remain retrievable after a rule is soft-deleted,
  // unlike every other :id-scoped endpoint on this router.
  it("returns 200 for a soft-deleted rule's execution history", async () => {
    existingRuleOverride = { ...mockRuleRow, deletedAt: new Date() };
    const res = await makeApp().request(
      `/admin/schedule-rules/${mockRuleRow.id}/executions`,
    );
    expect(res.status).toBe(200);
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
