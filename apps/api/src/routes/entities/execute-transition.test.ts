import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockExecuteTransition = vi.fn();
const mockWithTenantContext = vi.fn();

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

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (...args: unknown[]) => mockWithTenantContext(...args),
}));

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    executeTransition: (...args: unknown[]) => mockExecuteTransition(...args),
  };
});

const { executeTransitionHandler } = await import("./execute-transition.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/transitions", ...executeTransitionHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INST_ID = "00000000-0000-0000-0000-000000000002";
const TRANS_ID = "00000000-0000-0000-0000-000000000010";

const fakeEvent = {
  id: "00000000-0000-0000-0000-000000000099",
  instanceId: INST_ID,
  workflowId: "00000000-0000-0000-0000-000000000005",
  fromState: "open",
  toState: "in_progress",
  triggeredBy: "user" as const,
  actorId: "u-bbb",
  comment: null,
  metadata: {},
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /entities/:id/transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithTenantContext.mockImplementation(
      (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    );
  });

  it("returns 201 with the workflow event when transition succeeds", async () => {
    mockExecuteTransition.mockResolvedValue(fakeEvent);

    const res = await makeApp().request(`/${INST_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANS_ID }),
    });

    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.data.id).toBe(fakeEvent.id);
    expect(json.data.toState).toBe("in_progress");
  });

  it("passes comment and metadata to executeTransition", async () => {
    mockExecuteTransition.mockResolvedValue(fakeEvent);

    await makeApp().request(`/${INST_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transitionId: TRANS_ID,
        comment: "Looks good",
        metadata: { source: "ui" },
      }),
    });

    expect(mockExecuteTransition).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({
        comment: "Looks good",
        metadata: { source: "ui" },
      }),
    );
  });

  it("passes idempotencyKey directly in the transition request", async () => {
    mockExecuteTransition.mockResolvedValue(fakeEvent);

    await makeApp().request(`/${INST_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transitionId: TRANS_ID,
        idempotencyKey: "key-xyz",
      }),
    });

    expect(mockExecuteTransition).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({ idempotencyKey: "key-xyz" }),
    );
  });

  it("returns 400 when transitionId is missing", async () => {
    const res = await makeApp().request(`/${INST_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(mockExecuteTransition).not.toHaveBeenCalled();
  });

  it("returns 404 when the instance does not exist", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockExecuteTransition.mockRejectedValue(
      new WorkflowError("INSTANCE_NOT_FOUND"),
    );

    const res = await makeApp().request(`/${INST_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANS_ID }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("INSTANCE_NOT_FOUND");
  });

  it("returns 409 when the transition is not available from the current state", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockExecuteTransition.mockRejectedValue(
      new WorkflowError("TRANSITION_NOT_AVAILABLE"),
    );

    const res = await makeApp().request(`/${INST_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANS_ID }),
    });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("TRANSITION_NOT_AVAILABLE");
  });

  it("returns 403 when the actor lacks the required role", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockExecuteTransition.mockRejectedValue(
      new WorkflowError("TRANSITION_FORBIDDEN"),
    );

    const res = await makeApp().request(`/${INST_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANS_ID }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("TRANSITION_FORBIDDEN");
  });

  it("returns 422 when a transition condition is not met", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockExecuteTransition.mockRejectedValue(
      new WorkflowError("CONDITION_NOT_MET"),
    );

    const res = await makeApp().request(`/${INST_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANS_ID }),
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("CONDITION_NOT_MET");
  });

  it("returns 422 with missing field names when required fields are absent", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockExecuteTransition.mockRejectedValue(
      new WorkflowError("REQUIRED_FIELDS_MISSING", { missing: ["priority"] }),
    );

    const res = await makeApp().request(`/${INST_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANS_ID }),
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("REQUIRED_FIELDS_MISSING");
    expect(json.fields).toEqual(["priority"]);
  });

  it("wraps execution in withTenantContext", async () => {
    mockExecuteTransition.mockResolvedValue(fakeEvent);

    await makeApp().request(`/${INST_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANS_ID }),
    });

    expect(mockWithTenantContext).toHaveBeenCalledWith(
      "t-aaa",
      expect.any(Function),
    );
  });
});
