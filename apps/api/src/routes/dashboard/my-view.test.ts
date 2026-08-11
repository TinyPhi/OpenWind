import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Strategy: mirrors apps/api/src/routes/entities/my-tickets.test.ts — mock
// @platform/db so withTenantContext/withTenantAndUserContext return controlled
// data without calling the Drizzle callback. drizzle-orm operators are no-ops
// so query-construction code never throws.
//
// Call order per request (see my-view.ts): adminWorkflows (withTenantContext),
// savedViews (withTenantAndUserContext), then — only if adminWorkflows is
// non-empty — pendingApprovals (withTenantContext), then the R1-R3 ticket-
// scoped flow (withTenantContext: ids, rows, workflows, states, entityTypes).
// Tests that don't care about the v1.1 sections queue `[]` for
// adminWorkflows/savedViews so pendingApprovals' query is skipped entirely.

vi.mock("drizzle-orm", () => {
  const noop = vi.fn(() => "sql");
  const sqlFn = Object.assign(
    (_strings: TemplateStringsArray, ..._vals: unknown[]) => "sql",
    { join: vi.fn(() => "sql") },
  );
  return {
    eq: noop,
    and: noop,
    or: noop,
    isNull: noop,
    sql: sqlFn,
    inArray: noop,
    asc: noop,
    desc: noop,
  };
});

const mockWithTenantContext = vi.fn();
const mockWithTenantAndUserContext = vi.fn();

vi.mock("@platform/db", () => {
  const col = (name: string) => name;
  const tbl = (cols: string[]) =>
    Object.fromEntries(cols.map((c) => [c, col(c)]));
  return {
    db: {},
    withTenantContext: (...args: unknown[]) => mockWithTenantContext(...args),
    withTenantAndUserContext: (...args: unknown[]) =>
      mockWithTenantAndUserContext(...args),
    entityInstances: tbl([
      "id",
      "tenantId",
      "workflowId",
      "entityTypeId",
      "currentState",
      "fields",
      "dueDate",
      "updatedAt",
      "createdAt",
      "assignedTo",
      "createdBy",
      "deletedAt",
    ]),
    entityTypes: tbl(["id", "name"]),
    workflows: tbl(["id", "name", "entityTypeId", "createdBy", "assignedTo"]),
    workflowStates: tbl(["workflowId", "name", "label", "slaHours"]),
    savedViews: tbl(["id", "tenantId", "userId", "name", "entityTypeId"]),
    accessRequests: tbl([
      "id",
      "tenantId",
      "instanceId",
      "requesterId",
      "requestedLevel",
      "status",
      "createdAt",
    ]),
  };
});

vi.mock("@platform/workflow-engine", () => ({
  isWorkflowAdmin: (
    userId: string,
    wf: { createdBy: string | null; assignedTo: string[] },
  ) => wf.createdBy === userId || wf.assignedTo.includes(userId),
}));

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("auth", {
        tenantId: "tenant-aaa",
        userId: "user-bbb",
        roles: ["user"],
      } as AuthContext);
      return next();
    },
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { myViewHandler } = await import("./my-view.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/my-view", ...myViewHandler);
  return app;
}

const WF_ID = "00000000-0000-0000-0000-000000000001";
const ET_ID = "00000000-0000-0000-0000-0000000000e1";

function scopedIdRows(ids: string[]) {
  return ids.map((id) => ({ id }));
}

// Queues the two leading v1.1 calls (adminWorkflows, savedViews) as empty —
// use for tests that only care about the R1-R3 ticket-scoped flow.
function queueNoV11Sections() {
  mockWithTenantContext.mockResolvedValueOnce([]); // adminWorkflows
  mockWithTenantAndUserContext.mockResolvedValueOnce([]); // savedViews
}

describe("GET /dashboard/my-view", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty sections when user has no scoped tickets and administers nothing", async () => {
    queueNoV11Sections();
    mockWithTenantContext.mockResolvedValueOnce([]); // resolveUserScopedEntityIds

    const res = await makeApp().request("/my-view");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toEqual({
      workflows: [],
      tickets: { items: [], totalQualifying: 0 },
      dueDates: { items: [], totalQualifying: 0 },
      slaRisk: { items: [], totalQualifying: 0 },
      adminWorkflows: [],
      savedViews: [],
      pendingApprovals: { items: [], totalQualifying: 0 },
    });
  });

  it("builds a per-workflow, per-state count breakdown (R1)", async () => {
    queueNoV11Sections();
    mockWithTenantContext
      .mockResolvedValueOnce(scopedIdRows(["a", "b", "c"])) // ids
      .mockResolvedValueOnce([
        {
          id: "a",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: {},
          dueDate: null,
          updatedAt: new Date(),
        },
        {
          id: "b",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: {},
          dueDate: null,
          updatedAt: new Date(),
        },
        {
          id: "c",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "closed",
          fields: {},
          dueDate: null,
          updatedAt: new Date(),
        },
      ]) // full rows
      .mockResolvedValueOnce([{ id: WF_ID, name: "Helpdesk" }]) // workflows
      .mockResolvedValueOnce([
        { workflowId: WF_ID, name: "open", label: "Open", slaHours: null },
        { workflowId: WF_ID, name: "closed", label: "Closed", slaHours: null },
      ]) // states
      .mockResolvedValueOnce([{ id: ET_ID, name: "Ticket" }]); // entity types

    const res = await makeApp().request("/my-view");
    const { data } = await res.json();
    expect(data.workflows).toHaveLength(1);
    expect(data.workflows[0].workflowId).toBe(WF_ID);
    expect(data.workflows[0].workflowName).toBe("Helpdesk");
    expect(data.workflows[0].total).toBe(3);
    const open = data.workflows[0].counts.find(
      (c: { stateId: string }) => c.stateId === "open",
    );
    const closed = data.workflows[0].counts.find(
      (c: { stateId: string }) => c.stateId === "closed",
    );
    expect(open.count).toBe(2);
    expect(open.stateName).toBe("Open");
    expect(closed.count).toBe(1);
  });

  it("omits workflows the user has zero scoped tickets in — never a zero-count card", async () => {
    queueNoV11Sections();
    mockWithTenantContext
      .mockResolvedValueOnce(scopedIdRows(["a"]))
      .mockResolvedValueOnce([
        {
          id: "a",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: {},
          dueDate: null,
          updatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([{ id: WF_ID, name: "Helpdesk" }])
      .mockResolvedValueOnce([
        { workflowId: WF_ID, name: "open", label: "Open", slaHours: null },
      ])
      .mockResolvedValueOnce([{ id: ET_ID, name: "Ticket" }]);

    const res = await makeApp().request("/my-view");
    const { data } = await res.json();
    expect(data.workflows).toHaveLength(1);
  });

  it("due-date list marks past dates overdue, sorts soonest-first, excludes tickets with no due date (R2)", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future1 = new Date(Date.now() + 3_600_000).toISOString();
    const future2 = new Date(Date.now() + 7_200_000).toISOString();

    queueNoV11Sections();
    mockWithTenantContext
      .mockResolvedValueOnce(scopedIdRows(["a", "b", "c", "d"]))
      .mockResolvedValueOnce([
        {
          id: "a",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: { title: "Overdue one" },
          dueDate: new Date(past),
          updatedAt: new Date(),
        },
        {
          id: "b",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: { title: "Soonest" },
          dueDate: new Date(future1),
          updatedAt: new Date(),
        },
        {
          id: "c",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: { title: "Later" },
          dueDate: new Date(future2),
          updatedAt: new Date(),
        },
        {
          id: "d",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: {},
          dueDate: null,
          updatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([{ id: WF_ID, name: "Helpdesk" }])
      .mockResolvedValueOnce([
        { workflowId: WF_ID, name: "open", label: "Open", slaHours: null },
      ])
      .mockResolvedValueOnce([{ id: ET_ID, name: "Ticket" }]);

    const res = await makeApp().request("/my-view");
    const { data } = await res.json();
    expect(data.dueDates.totalQualifying).toBe(3);
    expect(
      data.dueDates.items.map((i: { entityId: string }) => i.entityId),
    ).toEqual(["a", "b", "c"]);
    expect(data.dueDates.items[0].isOverdue).toBe(true);
    expect(data.dueDates.items[1].isOverdue).toBe(false);
  });

  it("SLA-risk list only includes tickets in a state with sla_hours configured and time-in-state exceeded (R3)", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);

    queueNoV11Sections();
    mockWithTenantContext
      .mockResolvedValueOnce(scopedIdRows(["a", "b", "c"]))
      .mockResolvedValueOnce([
        // over sla_hours=1 by ~1h
        {
          id: "a",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "in_progress",
          fields: {},
          dueDate: null,
          updatedAt: twoHoursAgo,
        },
        // under sla_hours=1
        {
          id: "b",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "in_progress",
          fields: {},
          dueDate: null,
          updatedAt: tenMinutesAgo,
        },
        // state has no sla_hours configured — never eligible
        {
          id: "c",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "closed",
          fields: {},
          dueDate: null,
          updatedAt: twoHoursAgo,
        },
      ])
      .mockResolvedValueOnce([{ id: WF_ID, name: "Helpdesk" }])
      .mockResolvedValueOnce([
        {
          workflowId: WF_ID,
          name: "in_progress",
          label: "In Progress",
          slaHours: 1,
        },
        { workflowId: WF_ID, name: "closed", label: "Closed", slaHours: null },
      ])
      .mockResolvedValueOnce([{ id: ET_ID, name: "Ticket" }]);

    const res = await makeApp().request("/my-view");
    const { data } = await res.json();
    expect(data.slaRisk.totalQualifying).toBe(1);
    expect(data.slaRisk.items).toHaveLength(1);
    expect(data.slaRisk.items[0].entityId).toBe("a");
    expect(data.slaRisk.items[0].hoursOver).toBeGreaterThan(0);
  });

  it("degrades the due-date section only when its computation throws — workflows still returned (R8)", async () => {
    queueNoV11Sections();
    mockWithTenantContext
      .mockResolvedValueOnce(scopedIdRows(["a"]))
      .mockResolvedValueOnce([
        {
          id: "a",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: {},
          // malformed: not a real Date, so .getTime() throws inside the sort comparator
          dueDate: {
            getTime: () => {
              throw new Error("boom");
            },
          },
          updatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([{ id: WF_ID, name: "Helpdesk" }])
      .mockResolvedValueOnce([
        { workflowId: WF_ID, name: "open", label: "Open", slaHours: null },
      ])
      .mockResolvedValueOnce([{ id: ET_ID, name: "Ticket" }]);

    const res = await makeApp().request("/my-view");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.dueDates.unavailable).toBe(true);
    expect(data.dueDates.items).toEqual([]);
    expect(data.workflows).toHaveLength(1);
    expect(data.workflows[0].total).toBe(1);
  });

  it("caps dueDates and slaRisk at 20 items while reporting the true totalQualifying (R7)", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `t${i}`,
      workflowId: WF_ID,
      entityTypeId: ET_ID,
      currentState: "open",
      fields: {},
      dueDate: new Date(Date.now() + i * 60_000),
      updatedAt: new Date(),
    }));

    queueNoV11Sections();
    mockWithTenantContext
      .mockResolvedValueOnce(scopedIdRows(rows.map((r) => r.id)))
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ id: WF_ID, name: "Helpdesk" }])
      .mockResolvedValueOnce([
        { workflowId: WF_ID, name: "open", label: "Open", slaHours: null },
      ])
      .mockResolvedValueOnce([{ id: ET_ID, name: "Ticket" }]);

    const res = await makeApp().request("/my-view");
    const { data } = await res.json();
    expect(data.dueDates.items).toHaveLength(20);
    expect(data.dueDates.totalQualifying).toBe(25);
  });

  // ── v1.2: flat "my tickets" list (includes tickets with no due_date) ──────

  it("tickets lists every scoped ticket regardless of due_date, sorted overdue-first, then dated-soonest-first, then undated (v1.2)", async () => {
    const past = new Date(Date.now() - 86_400_000);
    const future1 = new Date(Date.now() + 3_600_000);
    const future2 = new Date(Date.now() + 7_200_000);

    queueNoV11Sections();
    mockWithTenantContext
      .mockResolvedValueOnce(
        scopedIdRows(["undated", "soonest", "later", "overdue"]),
      )
      .mockResolvedValueOnce([
        {
          id: "undated",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: { title: "No due date" },
          dueDate: null,
          updatedAt: new Date(),
        },
        {
          id: "soonest",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: { title: "Soonest" },
          dueDate: future1,
          updatedAt: new Date(),
        },
        {
          id: "later",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: { title: "Later" },
          dueDate: future2,
          updatedAt: new Date(),
        },
        {
          id: "overdue",
          workflowId: WF_ID,
          entityTypeId: ET_ID,
          currentState: "open",
          fields: { title: "Overdue" },
          dueDate: past,
          updatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([{ id: WF_ID, name: "Helpdesk" }])
      .mockResolvedValueOnce([
        { workflowId: WF_ID, name: "open", label: "Open", slaHours: null },
      ])
      .mockResolvedValueOnce([{ id: ET_ID, name: "Ticket" }]);

    const res = await makeApp().request("/my-view");
    const { data } = await res.json();
    expect(data.tickets.totalQualifying).toBe(4);
    expect(
      data.tickets.items.map((i: { entityId: string }) => i.entityId),
    ).toEqual(["overdue", "soonest", "later", "undated"]);
    expect(data.tickets.items[0].isOverdue).toBe(true);
    expect(data.tickets.items[3].dueDate).toBeNull();
    expect(data.tickets.items[3].isOverdue).toBe(false);
    expect(data.tickets.items[0].workflowName).toBe("Helpdesk");
    expect(data.tickets.items[0].stateName).toBe("Open");
  });

  it("caps tickets at 50 items while reporting the true totalQualifying (v1.2)", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      workflowId: WF_ID,
      entityTypeId: ET_ID,
      currentState: "open",
      fields: {},
      dueDate: null,
      updatedAt: new Date(),
    }));

    queueNoV11Sections();
    mockWithTenantContext
      .mockResolvedValueOnce(scopedIdRows(rows.map((r) => r.id)))
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ id: WF_ID, name: "Helpdesk" }])
      .mockResolvedValueOnce([
        { workflowId: WF_ID, name: "open", label: "Open", slaHours: null },
      ])
      .mockResolvedValueOnce([{ id: ET_ID, name: "Ticket" }]);

    const res = await makeApp().request("/my-view");
    const { data } = await res.json();
    expect(data.tickets.items).toHaveLength(50);
    expect(data.tickets.totalQualifying).toBe(60);
  });

  // ── v1.1 sections (R10-R12) ───────────────────────────────────────────────

  it("adminWorkflows lists only workflows the user created or is assigned to administer (R10)", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([
        {
          id: WF_ID,
          name: "Helpdesk",
          entityTypeId: ET_ID,
          createdBy: "someone-else",
          assignedTo: ["user-bbb"],
        },
        {
          id: "wf-not-mine",
          name: "Other",
          entityTypeId: ET_ID,
          createdBy: "someone-else",
          assignedTo: ["someone-else"],
        },
      ]) // adminWorkflows
      .mockResolvedValueOnce([]) // pendingApprovals — administers WF_ID, so this query runs
      .mockResolvedValueOnce([]); // resolveUserScopedEntityIds (no tickets)
    mockWithTenantAndUserContext.mockResolvedValueOnce([]); // savedViews

    const res = await makeApp().request("/my-view");
    const { data } = await res.json();
    expect(data.adminWorkflows).toEqual([
      { workflowId: WF_ID, workflowName: "Helpdesk", entityTypeId: ET_ID },
    ]);
  });

  it("savedViews returns all of the user's saved views across entity types (R11)", async () => {
    mockWithTenantContext.mockResolvedValueOnce([]); // adminWorkflows
    mockWithTenantAndUserContext.mockResolvedValueOnce([
      {
        id: "sv-1",
        name: "My Open Tickets",
        entityTypeId: ET_ID,
        entityTypeName: "Ticket",
      },
    ]); // savedViews
    mockWithTenantContext.mockResolvedValueOnce([]); // resolveUserScopedEntityIds

    const res = await makeApp().request("/my-view");
    const { data } = await res.json();
    expect(data.savedViews).toEqual([
      {
        id: "sv-1",
        name: "My Open Tickets",
        entityTypeId: ET_ID,
        entityTypeName: "Ticket",
      },
    ]);
  });

  it("pendingApprovals is empty and skips its query entirely when the user administers no workflows (R12)", async () => {
    queueNoV11Sections();
    mockWithTenantContext.mockResolvedValueOnce([]); // resolveUserScopedEntityIds

    const res = await makeApp().request("/my-view");
    const { data } = await res.json();
    expect(data.pendingApprovals).toEqual({ items: [], totalQualifying: 0 });
    // adminWorkflows + resolveUserScopedEntityIds only — no pendingApprovals query
    expect(mockWithTenantContext).toHaveBeenCalledTimes(2);
  });

  it("pendingApprovals lists pending access requests on administered workflows only (R12)", async () => {
    const createdAt = new Date();
    mockWithTenantContext
      .mockResolvedValueOnce([
        {
          id: WF_ID,
          name: "Helpdesk",
          entityTypeId: ET_ID,
          createdBy: "user-bbb",
          assignedTo: [],
        },
      ]) // adminWorkflows
      .mockResolvedValueOnce([
        {
          requestId: "req-1",
          entityId: "inst-1",
          entityTypeId: ET_ID,
          entityTypeName: "Ticket",
          fields: { title: "Needs review" },
          workflowId: WF_ID,
          workflowName: "Helpdesk",
          requesterId: "user-ccc",
          requestedLevel: "read_write",
          createdAt,
        },
      ]) // pendingApprovals
      .mockResolvedValueOnce([]); // resolveUserScopedEntityIds
    mockWithTenantAndUserContext.mockResolvedValueOnce([]); // savedViews

    const res = await makeApp().request("/my-view");
    const { data } = await res.json();
    expect(data.pendingApprovals.totalQualifying).toBe(1);
    expect(data.pendingApprovals.items).toEqual([
      {
        requestId: "req-1",
        entityId: "inst-1",
        entityTypeId: ET_ID,
        entityTypeName: "Ticket",
        title: "Needs review",
        requesterId: "user-ccc",
        workflowId: WF_ID,
        workflowName: "Helpdesk",
        requestedLevel: "read_write",
        createdAt: createdAt.toISOString(),
      },
    ]);
  });

  it("degrades pendingApprovals only when its query throws — adminWorkflows/savedViews still returned (R8-style)", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([
        {
          id: WF_ID,
          name: "Helpdesk",
          entityTypeId: ET_ID,
          createdBy: "user-bbb",
          assignedTo: [],
        },
      ]) // adminWorkflows
      .mockRejectedValueOnce(new Error("boom")) // pendingApprovals query fails
      .mockResolvedValueOnce([]); // resolveUserScopedEntityIds
    mockWithTenantAndUserContext.mockResolvedValueOnce([]); // savedViews

    const res = await makeApp().request("/my-view");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.pendingApprovals.unavailable).toBe(true);
    expect(data.adminWorkflows).toHaveLength(1);
  });
});
