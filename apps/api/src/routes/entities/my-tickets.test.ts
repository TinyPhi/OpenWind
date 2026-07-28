import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Strategy: mock @platform/db so withTenantContext returns controlled data
// without calling the Drizzle callback. drizzle-orm operators are mocked to
// no-ops so the query-construction code before the callback doesn't throw.
// @hono/zod-validator is NOT mocked — the real validator runs against the
// real Zod schema (MyTicketsQuerySchema only validates an optional UUID).

// ── drizzle-orm mock (no-ops — callbacks never execute, so SQL is never sent) ─

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

// ── @platform/db mock ──────────────────────────────────────────────────────────

const mockWithTenantContext = vi.fn();

vi.mock("@platform/db", () => {
  const col = (name: string) => name; // stub column — only used inside no-op drizzle calls
  const tbl = (cols: string[]) =>
    Object.fromEntries(cols.map((c) => [c, col(c)]));
  return {
    db: {},
    withTenantContext: (...args: unknown[]) => mockWithTenantContext(...args),
    entityInstances: tbl([
      "id",
      "tenantId",
      "workflowId",
      "currentState",
      "fields",
      "assignedTo",
      "createdBy",
      "createdAt",
      "deletedAt",
    ]),
    entityRelations: tbl([
      "id",
      "tenantId",
      "fromInstanceId",
      "toInstanceId",
      "relationType",
      "deletedAt",
      "createdAt",
    ]),
    workflows: tbl(["id", "name", "tenantId", "entityTypeId"]),
    workflowStates: tbl([
      "id",
      "workflowId",
      "name",
      "label",
      "color",
      "isTerminal",
      "sortOrder",
    ]),
    workflowTransitions: tbl(["id", "workflowId"]),
  };
});

// ── @platform/auth mock ────────────────────────────────────────────────────────

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
  requireRole:
    (..._roles: string[]) =>
    async (_c: unknown, next: () => Promise<void>) =>
      next(),
}));

const { myTicketsHandler } = await import("./my-tickets.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/my-tickets", ...myTicketsHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WF_ID = "00000000-0000-0000-0000-000000000001";
const TENANT = "tenant-aaa";
const USER = "user-bbb";
const OTHER = "user-ccc";

function makeRow(
  overrides: Partial<{
    id: string;
    workflowId: string | null;
    currentState: string;
    fields: Record<string, unknown>;
    assignedTo: string | null;
    createdBy: string | null;
  }> = {},
) {
  return {
    id: "inst-001",
    workflowId: WF_ID,
    currentState: "open",
    fields: {},
    assignedTo: null,
    createdBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const WF_META = [{ id: WF_ID, name: "Expense Claims" }];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /entities/my-tickets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty result when user has no accessible tickets", async () => {
    mockWithTenantContext.mockResolvedValueOnce([]);

    const res = await makeApp().request("/my-tickets");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      workflows: [],
      parentTickets: [],
      childTickets: [],
      hasMore: false,
    });
    // Short-circuits — no further DB calls needed
    expect(mockWithTenantContext).toHaveBeenCalledTimes(1);
  });

  it("always passes tenantId from auth to withTenantContext", async () => {
    mockWithTenantContext.mockResolvedValue([]);

    await makeApp().request("/my-tickets");

    expect(mockWithTenantContext).toHaveBeenCalledWith(
      TENANT,
      expect.any(Function),
    );
  });

  it("classifies ticket as parent and sets accessReason=creator when user is creator", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([makeRow({ id: "inst-1", createdBy: USER })])
      .mockResolvedValueOnce([]) // no child_of relations
      .mockResolvedValueOnce(WF_META); // workflows

    const res = await makeApp().request("/my-tickets");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.parentTickets).toHaveLength(1);
    expect(data.parentTickets[0].id).toBe("inst-1");
    expect(data.parentTickets[0].accessReason).toBe("creator");
    expect(data.childTickets).toHaveLength(0);
  });

  it("classifies ticket as parent and sets accessReason=assigned when user is assignee", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([
        makeRow({ id: "inst-2", assignedTo: USER, createdBy: OTHER }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(WF_META);

    const { data } = await (await makeApp().request("/my-tickets")).json();
    expect(data.parentTickets[0].accessReason).toBe("assigned");
  });

  it("classifies ticket as parent and sets accessReason=mention for __accessUsers mention tag", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([
        makeRow({
          id: "inst-3",
          createdBy: OTHER,
          fields: {
            __accessUsers: {
              [USER]: { level: "read_comment", tag: "mention" },
            },
          },
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(WF_META);

    const { data } = await (await makeApp().request("/my-tickets")).json();
    expect(data.parentTickets[0].accessReason).toBe("mention");
  });

  it("classifies ticket as parent and sets accessReason=manual for __accessUsers manual tag", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([
        makeRow({
          id: "inst-4",
          createdBy: OTHER,
          fields: {
            __accessUsers: { [USER]: { level: "read_write", tag: "manual" } },
          },
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(WF_META);

    const { data } = await (await makeApp().request("/my-tickets")).json();
    expect(data.parentTickets[0].accessReason).toBe("manual");
  });

  it("classifies ticket as child when it has a child_of relation, uses parent state for column", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([makeRow({ id: "child-1", assignedTo: USER })])
      .mockResolvedValueOnce([
        { fromInstanceId: "child-1", toInstanceId: "parent-1" },
      ])
      .mockResolvedValueOnce([
        { id: "parent-1", currentState: "in_progress", deletedAt: null },
      ])
      .mockResolvedValueOnce(WF_META);

    const { data } = await (await makeApp().request("/my-tickets")).json();
    expect(data.parentTickets).toHaveLength(0);
    expect(data.childTickets).toHaveLength(1);
    expect(data.childTickets[0].id).toBe("child-1");
    expect(data.childTickets[0].parentId).toBe("parent-1");
    expect(data.childTickets[0].parentCurrentState).toBe("in_progress");
  });

  it("excludes child ticket when parent is archived (deletedAt set on parent)", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([makeRow({ id: "child-2", assignedTo: USER })])
      .mockResolvedValueOnce([
        { fromInstanceId: "child-2", toInstanceId: "parent-archived" },
      ])
      .mockResolvedValueOnce([
        { id: "parent-archived", currentState: "open", deletedAt: new Date() },
      ])
      .mockResolvedValueOnce(WF_META);

    const { data } = await (await makeApp().request("/my-tickets")).json();
    expect(data.childTickets).toHaveLength(0);
  });

  it("builds workflow rollup with correct accessible ticket count (parents only)", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([
        makeRow({ id: "a", createdBy: USER }),
        makeRow({ id: "b", assignedTo: USER }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(WF_META);

    const { data } = await (await makeApp().request("/my-tickets")).json();
    expect(data.workflows).toHaveLength(1);
    expect(data.workflows[0].workflowId).toBe(WF_ID);
    expect(data.workflows[0].accessibleTicketCount).toBe(2);
    expect(data.workflows[0].workflowSlug).toBe("expense-claims");
  });

  it("workflow count includes accessible child tickets alongside parent tickets", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([
        makeRow({ id: "parent-x", createdBy: USER }),
        makeRow({ id: "child-x", assignedTo: USER }),
      ])
      .mockResolvedValueOnce([
        { fromInstanceId: "child-x", toInstanceId: "parent-x" },
      ])
      .mockResolvedValueOnce([
        { id: "parent-x", currentState: "open", deletedAt: null },
      ])
      .mockResolvedValueOnce([{ id: WF_ID, name: "Support" }]);

    const { data } = await (await makeApp().request("/my-tickets")).json();
    expect(data.workflows[0].accessibleTicketCount).toBe(2);
    expect(data.parentTickets).toHaveLength(1);
    expect(data.childTickets).toHaveLength(1);
  });

  it("child accessReason falls back to manual when child has creator tag (children cannot be creators)", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([makeRow({ id: "child-3", createdBy: USER })])
      .mockResolvedValueOnce([
        { fromInstanceId: "child-3", toInstanceId: "parent-2" },
      ])
      .mockResolvedValueOnce([
        { id: "parent-2", currentState: "open", deletedAt: null },
      ])
      .mockResolvedValueOnce(WF_META);

    const { data } = await (await makeApp().request("/my-tickets")).json();
    // creator tag is remapped to "manual" for child tickets in the spec
    expect(data.childTickets[0].accessReason).toBe("manual");
  });

  it("workflow rollup includes entityTypeId, states, and transitionCount for card rendering", async () => {
    // Query order for a single-workflow, no-children case: accessibleRows,
    // childRelations, then the three parallel workflow-metadata queries
    // (workflowRows, stateRows, transitionRows) added so a plain "user"
    // caller's records-page card can render the same icon/state chips an
    // admin's card gets — previously my-tickets only returned bare id/name.
    mockWithTenantContext
      .mockResolvedValueOnce([makeRow({ id: "a", createdBy: USER })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: WF_ID, name: "Expense Claims", entityTypeId: "et-001" },
      ])
      .mockResolvedValueOnce([
        {
          workflowId: WF_ID,
          name: "open",
          label: "Open",
          color: "#0ea5e9",
          isTerminal: false,
        },
        {
          workflowId: WF_ID,
          name: "closed",
          label: "Closed",
          color: null,
          isTerminal: true,
        },
      ])
      .mockResolvedValueOnce([{ workflowId: WF_ID }, { workflowId: WF_ID }]);

    const { data } = await (await makeApp().request("/my-tickets")).json();
    expect(data.workflows).toHaveLength(1);
    expect(data.workflows[0].entityTypeId).toBe("et-001");
    expect(data.workflows[0].states).toHaveLength(2);
    expect(data.workflows[0].states[0]).toMatchObject({
      name: "open",
      label: "Open",
    });
    expect(data.workflows[0].transitionCount).toBe(2);
  });

  it("workflow slug is derived from workflow name", async () => {
    mockWithTenantContext
      .mockResolvedValueOnce([
        makeRow({ id: "x", createdBy: USER, workflowId: WF_ID }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: WF_ID, name: "IT Support Requests" }]);

    const { data } = await (await makeApp().request("/my-tickets")).json();
    expect(data.workflows[0].workflowSlug).toBe("it-support-requests");
  });
});
