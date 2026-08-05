import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";
import { WorkflowError } from "@platform/workflow-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetWorkflow = vi.fn();

let currentAuth: AuthContext;

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
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
  };
});

vi.mock("../../lib/handle-workflow-error.js", () => ({
  handleWorkflowError: (
    c: { json: (body: unknown, status: number) => unknown },
    err: unknown,
  ) => {
    if (err instanceof WorkflowError && err.code === "WORKFLOW_NOT_FOUND") {
      return c.json(
        { error: "WORKFLOW_NOT_FOUND", message: "Workflow not found" },
        404,
      );
    }
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

  it("allows a plain role=user tenant member with no relation to the workflow and no tickets in it — tenant-wide read, not gated on ownership/tickets", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(200);
    expect(mockGetWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-aaa",
      WF_ID,
      expect.objectContaining({ userId: "user-bbb" }),
    );
  });

  it("allows a plain role=agent tenant member with no relation to the workflow either", async () => {
    currentAuth.roles = ["agent"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(200);
  });

  it("returns 404 for a genuinely nonexistent or cross-tenant workflow id — getWorkflow itself still throws", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockRejectedValue(
      new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId: WF_ID }),
    );

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("WORKFLOW_NOT_FOUND");
  });

  it("ignores an entityId query param — it is no longer part of the authorization decision", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());

    const res = await makeApp().request(`/${WF_ID}?entityId=e-001`);

    expect(res.status).toBe(200);
  });
});
