import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCreate = vi.fn();
const mockList = vi.fn();
const mockGet = vi.fn();
const mockDelete = vi.fn();

let mockAuthOverride: Partial<AuthContext> = {};
vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: "t-aaa",
        userId: "u-bbb",
        roles: ["admin"],
        email: "test@example.com",
        ...mockAuthOverride,
      });
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

const mockTx = {};
vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

const mockWriteAuditEntry = vi.fn();
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    createWorkflow: (...args: unknown[]) => mockCreate(...args),
    listWorkflows: (...args: unknown[]) => mockList(...args),
    getWorkflow: (...args: unknown[]) => mockGet(...args),
    deleteWorkflow: (...args: unknown[]) => mockDelete(...args),
  };
});

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createWorkflowHandler } = await import("./create.js");
const { listWorkflowsHandler } = await import("./list.js");
const { getWorkflowHandler } = await import("./get.js");
const { deleteWorkflowHandler } = await import("./delete.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WF_ID = "00000000-0000-0000-0000-000000000010";
const TYPE_ID = "00000000-0000-0000-0000-000000000001";

const fakeWorkflow = {
  id: WF_ID,
  tenantId: "t-aaa",
  entityTypeId: TYPE_ID,
  name: "Support Ticket Workflow",
  initialState: "open",
  createdAt: new Date(),
};

const fakeWorkflowFull = {
  ...fakeWorkflow,
  states: [],
  transitions: [],
};

// ── Test apps ─────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/", ...createWorkflowHandler);
  app.get("/", ...listWorkflowsHandler);
  app.get("/:id", ...getWorkflowHandler);
  app.delete("/:id", ...deleteWorkflowHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  it("writes a workflow.admins_updated entry with before [] and after [creator] (#640)", async () => {
    mockCreate.mockResolvedValue({ ...fakeWorkflow, assignedTo: ["u-bbb"] });

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityTypeId: TYPE_ID,
        name: "Support Ticket Workflow",
        initialState: "open",
      }),
    });

    expect(res.status).toBe(201);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        tenantId: "t-aaa",
        actorId: "u-bbb",
        resourceType: "workflow",
        resourceId: WF_ID,
        action: "workflow.admins_updated",
        beforeSnapshot: { assignedTo: [] },
        afterSnapshot: { assignedTo: ["u-bbb"] },
      }),
    );
  });

  it("fails the request when the audit write rejects", async () => {
    mockCreate.mockResolvedValue({ ...fakeWorkflow, assignedTo: ["u-bbb"] });
    mockWriteAuditEntry.mockRejectedValue(new Error("audit down"));

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityTypeId: TYPE_ID,
        name: "Support Ticket Workflow",
        initialState: "open",
      }),
    });

    expect(res.status).toBe(500);
  });

  it("returns 201 with created workflow", async () => {
    mockCreate.mockResolvedValue(fakeWorkflow);

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityTypeId: TYPE_ID,
        name: "Support Ticket Workflow",
        initialState: "open",
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.id).toBe(WF_ID);
    expect(mockCreate).toHaveBeenCalledWith(
      mockTx,
      "t-aaa",
      "u-bbb",
      expect.objectContaining({ name: "Support Ticket Workflow" }),
    );
  });

  it("returns 400 when entityTypeId is not a UUID", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityTypeId: "not-uuid",
        name: "x",
        initialState: "open",
      }),
    });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when name is missing", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityTypeId: TYPE_ID, initialState: "open" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /workflows", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with list of workflows", async () => {
    mockList.mockResolvedValue([fakeWorkflowFull]);

    const res = await makeApp().request(`/?entityTypeId=${TYPE_ID}`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(mockList).toHaveBeenCalledWith(
      {},
      "t-aaa",
      { userId: "u-bbb", isGlobalAdmin: true },
      TYPE_ID,
      false,
      100,
      0,
    );
  });

  it("allows missing entityTypeId and returns 200", async () => {
    mockList.mockResolvedValue([fakeWorkflowFull]);
    const res = await makeApp().request("/");
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(
      {},
      "t-aaa",
      { userId: "u-bbb", isGlobalAdmin: true },
      undefined,
      false,
      100,
      0,
    );
  });
});

describe("GET /workflows/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with full workflow including states and transitions", async () => {
    mockGet.mockResolvedValue(fakeWorkflowFull);

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(WF_ID);
    expect(json.data.states).toEqual([]);
    expect(json.data.transitions).toEqual([]);
  });

  it("returns 404 when workflow not found", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockGet.mockRejectedValue(new WorkflowError("WORKFLOW_NOT_FOUND"));

    const res = await makeApp().request(`/${WF_ID}`);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /workflows/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthOverride = {};
    mockGet.mockResolvedValue({ transitions: [] });
  });

  it("refuses (403) when the workflow has an actor rule and the caller is not a person admin (#1008)", async () => {
    mockGet.mockResolvedValue({
      transitions: [{ conditions: { op: "actor_not_creator" } }],
    });
    mockAuthOverride = { userId: "apikey:k1" };

    const res = await makeApp().request(`/${WF_ID}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("returns 204 on successful deletion", async () => {
    mockDelete.mockResolvedValue(undefined);

    const res = await makeApp().request(`/${WF_ID}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith({}, "t-aaa", WF_ID, {
      userId: "u-bbb",
      isGlobalAdmin: true,
    });
  });

  it("returns 409 when workflow has active instances", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockDelete.mockRejectedValue(
      new WorkflowError("WORKFLOW_HAS_ACTIVE_INSTANCES"),
    );

    const res = await makeApp().request(`/${WF_ID}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("WORKFLOW_HAS_ACTIVE_INSTANCES");
  });

  it("returns 404 when workflow not found", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockDelete.mockRejectedValue(new WorkflowError("WORKFLOW_NOT_FOUND"));

    const res = await makeApp().request(`/${WF_ID}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
