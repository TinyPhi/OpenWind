import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetWorkflow = vi.fn();

let currentAuth: AuthContext;
// Queue of rows consumed, in call order, by successive entityInstances
// queries within a single request: the ?entityId= proof lookup runs first
// (only when entityId is present), then the "does the caller own any record
// in this workflow" fallback lookup runs if still unauthorized. Each test
// pushes exactly the results its own request will trigger, in order.
let dbResultQueue: Array<
  Array<{
    createdBy: string | null;
    assignedTo: string | null;
    fields: unknown;
    workflowId: string | null;
  }>
>;

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", currentAuth);
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("@platform/db", () => ({
  entityInstances: {
    id: "id",
    tenantId: "tenantId",
    createdBy: "createdBy",
    assignedTo: "assignedTo",
    fields: "fields",
    workflowId: "workflowId",
  },
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) => {
    const tx: Record<string, unknown> = {};
    tx["select"] = () => tx;
    tx["from"] = () => tx;
    tx["where"] = () => tx;
    tx["limit"] = () => Promise.resolve(dbResultQueue.shift() ?? []);
    return fn(tx);
  },
}));

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
  };
});

vi.mock("../../lib/handle-workflow-error.js", () => ({
  handleWorkflowError: (_c: unknown, err: unknown) => {
    throw err;
  },
}));

const { getWorkflowHandler } = await import("./get.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WF_ID = "wf-001";
const fakeWorkflowFull = (
  overrides: Partial<{ createdBy: string | null; assignedTo: string[] }> = {},
) => ({
  id: WF_ID,
  tenantId: "tenant-aaa",
  entityTypeId: "type-001",
  name: "Support",
  initialState: "open",
  isActive: true,
  createdBy: overrides.createdBy ?? null,
  assignedTo: overrides.assignedTo ?? [],
  maxChildDepth: 1,
  maxChildrenPerParent: 10,
  createdAt: new Date(),
  states: [],
  transitions: [],
});

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/:id", ...(getWorkflowHandler as Parameters<typeof app.get>[1][]));
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /workflows/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResultQueue = [];
    currentAuth = {
      tenantId: "tenant-aaa",
      userId: "user-bbb",
      roles: ["admin"],
      email: "test@example.com",
    } as AuthContext;
  });

  it("allows a global admin to read any workflow", async () => {
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(200);
  });

  it("allows the workflow creator (workflow admin) to read it", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(
      fakeWorkflowFull({ createdBy: "user-bbb" }),
    );

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(200);
  });

  it("allows a designated workflow admin (in assignedTo) to read it", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(
      fakeWorkflowFull({ assignedTo: ["user-bbb"] }),
    );

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(200);
  });

  it("blocks a plain tenant member with no relation to the workflow, no entityId proof, and no owned records — 404, not 403", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());
    dbResultQueue = [[]]; // "any owned record in this workflow" fallback query

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("WORKFLOW_NOT_FOUND");
  });

  it("blocks a plain tenant member even with an agent role and no owned records (agent is not a blanket workflow-admin bypass)", async () => {
    currentAuth.roles = ["agent"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());
    dbResultQueue = [[]];

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(404);
  });

  it("allows a non-workflow-admin caller who proves read access to a record in this workflow via ?entityId=", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());
    dbResultQueue = [
      [
        {
          createdBy: "user-bbb",
          assignedTo: null,
          fields: {},
          workflowId: WF_ID,
        },
      ],
    ];

    const res = await makeApp().request(`/${WF_ID}?entityId=e-001`);

    expect(res.status).toBe(200);
  });

  it("rejects ?entityId= when the entity's workflowId does not match the requested workflow, and caller owns no record here either", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());
    dbResultQueue = [
      [
        {
          createdBy: "user-bbb",
          assignedTo: null,
          fields: {},
          workflowId: "some-other-workflow",
        },
      ],
      [], // fallback "own any record in this workflow" query
    ];

    const res = await makeApp().request(`/${WF_ID}?entityId=e-001`);

    expect(res.status).toBe(404);
  });

  it("rejects ?entityId= when the caller has no read access to that entity, and owns no record here either", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());
    dbResultQueue = [
      [
        {
          createdBy: "someone-else",
          assignedTo: null,
          fields: {},
          workflowId: WF_ID,
        },
      ],
      [], // fallback query
    ];

    const res = await makeApp().request(`/${WF_ID}?entityId=e-001`);

    expect(res.status).toBe(404);
  });

  it("allows the caller via the fallback when ?entityId= doesn't prove access but they own a different record in the same workflow", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());
    dbResultQueue = [
      [
        {
          createdBy: "someone-else",
          assignedTo: null,
          fields: {},
          workflowId: WF_ID,
        },
      ],
      [
        {
          createdBy: "user-bbb",
          assignedTo: null,
          fields: {},
          workflowId: WF_ID,
        },
      ],
    ];

    const res = await makeApp().request(`/${WF_ID}?entityId=e-001`);

    expect(res.status).toBe(200);
  });

  it("allows a plain tenant member with no entityId (kanban board fetch) who owns a record in this workflow", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());
    dbResultQueue = [
      [
        {
          createdBy: "user-bbb",
          assignedTo: null,
          fields: {},
          workflowId: WF_ID,
        },
      ],
    ];

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(200);
  });

  it("rejects ?entityId= pointing at a non-existent/cross-tenant entity, with no owned records either", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());
    dbResultQueue = [[], []];

    const res = await makeApp().request(`/${WF_ID}?entityId=e-999`);

    expect(res.status).toBe(404);
  });
});
