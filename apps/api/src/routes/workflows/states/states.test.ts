import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

const mockAddState = vi.fn();
const mockUpdateState = vi.fn();
const mockDeleteState = vi.fn();

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: "t-aaa",
        userId: "u-bbb",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("@platform/db", () => ({ db: {} }));

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    addWorkflowState: (...args: unknown[]) => mockAddState(...args),
    updateWorkflowState: (...args: unknown[]) => mockUpdateState(...args),
    deleteWorkflowState: (...args: unknown[]) => mockDeleteState(...args),
  };
});

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createStateHandler } = await import("./create-state.js");
const { updateStateHandler } = await import("./update-state.js");
const { deleteStateHandler } = await import("./delete-state.js");

const WF_ID = "00000000-0000-0000-0000-000000000010";
const STATE_ID = "00000000-0000-0000-0000-000000000020";

const fakeState = {
  id: STATE_ID,
  workflowId: WF_ID,
  name: "open",
  label: "Open",
  color: "#22c55e",
  isTerminal: false,
  slaHours: null,
  sortOrder: 0,
};

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/states", ...createStateHandler);
  app.patch("/:id/states/:stateId", ...updateStateHandler);
  app.delete("/:id/states/:stateId", ...deleteStateHandler);
  return app;
}

describe("POST /workflows/:id/states", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 201 with created state", async () => {
    mockAddState.mockResolvedValue(fakeState);

    const res = await makeApp().request(`/${WF_ID}/states`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "open", label: "Open", color: "#22c55e" }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.name).toBe("open");
    expect(mockAddState).toHaveBeenCalledWith(
      {},
      "t-aaa",
      WF_ID,
      expect.objectContaining({ name: "open", label: "Open" }),
    );
  });

  it("returns 400 when name is missing", async () => {
    const res = await makeApp().request(`/${WF_ID}/states`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Open" }),
    });
    expect(res.status).toBe(400);
    expect(mockAddState).not.toHaveBeenCalled();
  });

  it("returns 404 when workflow not found", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockAddState.mockRejectedValue(new WorkflowError("WORKFLOW_NOT_FOUND"));

    const res = await makeApp().request(`/${WF_ID}/states`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "open", label: "Open" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /workflows/:id/states/:stateId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with updated state", async () => {
    mockUpdateState.mockResolvedValue({ ...fakeState, label: "In Progress" });

    const res = await makeApp().request(`/${WF_ID}/states/${STATE_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "In Progress" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.label).toBe("In Progress");
  });

  it("returns 404 when state not found", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockUpdateState.mockRejectedValue(
      new WorkflowError("WORKFLOW_STATE_NOT_FOUND"),
    );

    const res = await makeApp().request(`/${WF_ID}/states/${STATE_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /workflows/:id/states/:stateId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 204 on success", async () => {
    mockDeleteState.mockResolvedValue(undefined);

    const res = await makeApp().request(`/${WF_ID}/states/${STATE_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  it("returns 409 when state is in use by a transition", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockDeleteState.mockRejectedValue(
      new WorkflowError("WORKFLOW_STATE_IN_USE"),
    );

    const res = await makeApp().request(`/${WF_ID}/states/${STATE_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("WORKFLOW_STATE_IN_USE");
  });
});
