import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

const mockAddTransition = vi.fn();
const mockUpdateTransition = vi.fn();
const mockDeleteTransition = vi.fn();

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
    addWorkflowTransition: (...args: unknown[]) => mockAddTransition(...args),
    updateWorkflowTransition: (...args: unknown[]) =>
      mockUpdateTransition(...args),
    deleteWorkflowTransition: (...args: unknown[]) =>
      mockDeleteTransition(...args),
  };
});

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createTransitionHandler } = await import("./create-transition.js");
const { updateTransitionHandler } = await import("./update-transition.js");
const { deleteTransitionHandler } = await import("./delete-transition.js");

const WF_ID = "00000000-0000-0000-0000-000000000010";
const TRANS_ID = "00000000-0000-0000-0000-000000000030";

const fakeTransition = {
  id: TRANS_ID,
  workflowId: WF_ID,
  fromState: "open",
  toState: "in_progress",
  label: "Start",
  allowedRoles: [],
  conditions: null,
  requiresComment: false,
  requiresFields: [],
};

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/transitions", ...createTransitionHandler);
  app.patch("/:id/transitions/:transitionId", ...updateTransitionHandler);
  app.delete("/:id/transitions/:transitionId", ...deleteTransitionHandler);
  return app;
}

describe("POST /workflows/:id/transitions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 201 with created transition", async () => {
    mockAddTransition.mockResolvedValue(fakeTransition);

    const res = await makeApp().request(`/${WF_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromState: "open", toState: "in_progress", label: "Start" }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.fromState).toBe("open");
    expect(mockAddTransition).toHaveBeenCalledWith(
      {},
      "t-aaa",
      WF_ID,
      expect.objectContaining({ fromState: "open", toState: "in_progress" }),
    );
  });

  it("returns 400 when fromState is missing", async () => {
    const res = await makeApp().request(`/${WF_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toState: "in_progress" }),
    });
    expect(res.status).toBe(400);
    expect(mockAddTransition).not.toHaveBeenCalled();
  });

  it("accepts optional allowedRoles and conditions", async () => {
    mockAddTransition.mockResolvedValue(fakeTransition);

    await makeApp().request(`/${WF_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromState: "open",
        toState: "closed",
        allowedRoles: ["admin"],
        conditions: { op: "eq", field: "priority", value: "high" },
      }),
    });

    expect(mockAddTransition).toHaveBeenCalledWith(
      {},
      "t-aaa",
      WF_ID,
      expect.objectContaining({ allowedRoles: ["admin"] }),
    );
  });
});

describe("PATCH /workflows/:id/transitions/:transitionId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with updated transition", async () => {
    mockUpdateTransition.mockResolvedValue({
      ...fakeTransition,
      allowedRoles: ["admin"],
    });

    const res = await makeApp().request(
      `/${WF_ID}/transitions/${TRANS_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedRoles: ["admin"] }),
      },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.allowedRoles).toEqual(["admin"]);
  });

  it("returns 404 when transition not found", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockUpdateTransition.mockRejectedValue(
      new WorkflowError("WORKFLOW_TRANSITION_NOT_FOUND"),
    );

    const res = await makeApp().request(
      `/${WF_ID}/transitions/${TRANS_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "x" }),
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /workflows/:id/transitions/:transitionId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 204 on success", async () => {
    mockDeleteTransition.mockResolvedValue(undefined);

    const res = await makeApp().request(
      `/${WF_ID}/transitions/${TRANS_ID}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);
    expect(mockDeleteTransition).toHaveBeenCalledWith({}, "t-aaa", WF_ID, TRANS_ID);
  });

  it("returns 404 when transition not found", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockDeleteTransition.mockRejectedValue(
      new WorkflowError("WORKFLOW_TRANSITION_NOT_FOUND"),
    );

    const res = await makeApp().request(
      `/${WF_ID}/transitions/${TRANS_ID}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });
});
