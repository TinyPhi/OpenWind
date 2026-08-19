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
  states: [{ id: "open" }],
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
    const body = await res.json();
    expect(body.data.states).toEqual([{ id: "open" }]);
  });

  it("allows the workflow creator (workflow admin) to read it", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(
      fakeWorkflowFull({ createdBy: "user-bbb" }),
    );

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(200);
  });

  it("allows a plain user-role caller with zero existing tickets in the workflow (empty records-page state, e.g. to create their first ticket)", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.states).toEqual([{ id: "open" }]);
  });

  it("allows a plain agent-role caller with no relation to the workflow (no owned records, not a workflow admin)", async () => {
    currentAuth.roles = ["agent"];
    mockGetWorkflow.mockResolvedValue(fakeWorkflowFull());

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(200);
  });

  it("returns 404 WORKFLOW_NOT_FOUND, not 403, for a cross-tenant or nonexistent workflow id", async () => {
    currentAuth.roles = ["user"];
    mockGetWorkflow.mockRejectedValue(
      new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId: WF_ID }),
    );

    const res = await makeApp().request(`/${WF_ID}`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("WORKFLOW_NOT_FOUND");
  });
});
