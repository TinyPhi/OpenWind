import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

const mockExecuteTransition = vi.fn();
const mockGetAvailableTransitions = vi.fn();
const mockGetWorkflowEventLog = vi.fn();
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
    getAvailableTransitions: (...args: unknown[]) =>
      mockGetAvailableTransitions(...args),
    getWorkflowEventLog: (...args: unknown[]) =>
      mockGetWorkflowEventLog(...args),
  };
});

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { executeTransitionHandler } = await import("./execute-transition.js");
const { listTransitionsHandler } = await import("./list-transitions.js");
const { listEventsHandler } = await import("./list-events.js");

const INSTANCE_ID = "00000000-0000-0000-0000-000000000001";
const TRANSITION_ID = "00000000-0000-0000-0000-000000000002";
const WF_ID = "00000000-0000-0000-0000-000000000003";

const fakeEvent = {
  id: "00000000-0000-0000-0000-000000000010",
  instanceId: INSTANCE_ID,
  workflowId: WF_ID,
  fromState: "open",
  toState: "in_progress",
  triggeredBy: "user" as const,
  actorId: "u-bbb",
  comment: null,
  metadata: {},
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const fakeTransition = {
  id: TRANSITION_ID,
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
  app.post("/:id/transitions", ...executeTransitionHandler);
  app.get("/:id/transitions", ...listTransitionsHandler);
  app.get("/:id/events", ...listEventsHandler);
  return app;
}

describe("POST /entities/:id/transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithTenantContext.mockImplementation(
      (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    );
  });

  it("returns 200 with workflow event on success", async () => {
    mockExecuteTransition.mockResolvedValue(fakeEvent);

    const res = await makeApp().request(`/${INSTANCE_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANSITION_ID }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.fromState).toBe("open");
    expect(json.data.toState).toBe("in_progress");
    expect(mockExecuteTransition).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({
        instanceId: INSTANCE_ID,
        transitionId: TRANSITION_ID,
        actorId: "u-bbb",
        actorRoles: ["admin"],
        triggeredBy: "user",
      }),
    );
  });

  it("returns 400 when transitionId is missing", async () => {
    const res = await makeApp().request(`/${INSTANCE_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment: "oops" }),
    });
    expect(res.status).toBe(400);
    expect(mockExecuteTransition).not.toHaveBeenCalled();
  });

  it("returns 400 when transitionId is not a UUID", async () => {
    const res = await makeApp().request(`/${INSTANCE_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when instance is not found", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockExecuteTransition.mockRejectedValue(
      new WorkflowError("INSTANCE_NOT_FOUND"),
    );

    const res = await makeApp().request(`/${INSTANCE_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANSITION_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when transition is not available from current state", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockExecuteTransition.mockRejectedValue(
      new WorkflowError("TRANSITION_NOT_AVAILABLE"),
    );

    const res = await makeApp().request(`/${INSTANCE_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANSITION_ID }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("TRANSITION_NOT_AVAILABLE");
  });

  it("returns 409 on pessimistic lock conflict (55P03)", async () => {
    const lockErr = Object.assign(new Error("lock"), { code: "55P03" });
    mockExecuteTransition.mockRejectedValue(lockErr);

    const res = await makeApp().request(`/${INSTANCE_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANSITION_ID }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("TRANSITION_CONFLICT");
  });

  it("returns 403 when actor role is not allowed", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockExecuteTransition.mockRejectedValue(
      new WorkflowError("TRANSITION_FORBIDDEN"),
    );

    const res = await makeApp().request(`/${INSTANCE_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANSITION_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 422 when conditions are not met", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockExecuteTransition.mockRejectedValue(
      new WorkflowError("CONDITION_NOT_MET"),
    );

    const res = await makeApp().request(`/${INSTANCE_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANSITION_ID }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("CONDITION_NOT_MET");
  });

  it("returns 422 when required fields are missing", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockExecuteTransition.mockRejectedValue(
      new WorkflowError("REQUIRED_FIELDS_MISSING", { missing: ["priority"] }),
    );

    const res = await makeApp().request(`/${INSTANCE_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: TRANSITION_ID }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("REQUIRED_FIELDS_MISSING");
  });

  it("passes idempotencyKey and returns same event on replay", async () => {
    mockExecuteTransition.mockResolvedValue(fakeEvent);

    await makeApp().request(`/${INSTANCE_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transitionId: TRANSITION_ID,
        idempotencyKey: "idem-abc-123",
      }),
    });

    expect(mockExecuteTransition).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({ idempotencyKey: "idem-abc-123" }),
    );
  });
});

describe("GET /entities/:id/transitions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with available transitions using auth roles", async () => {
    mockGetAvailableTransitions.mockResolvedValue([fakeTransition]);

    const res = await makeApp().request(`/${INSTANCE_ID}/transitions`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe(TRANSITION_ID);
    expect(mockGetAvailableTransitions).toHaveBeenCalledWith(
      {},
      "t-aaa",
      INSTANCE_ID,
      ["admin"],
    );
  });

  it("uses roles query param when provided", async () => {
    mockGetAvailableTransitions.mockResolvedValue([]);

    await makeApp().request(`/${INSTANCE_ID}/transitions?roles=agent,viewer`);

    expect(mockGetAvailableTransitions).toHaveBeenCalledWith(
      {},
      "t-aaa",
      INSTANCE_ID,
      ["agent", "viewer"],
    );
  });

  it("returns empty list when instance has no workflow", async () => {
    mockGetAvailableTransitions.mockResolvedValue([]);

    const res = await makeApp().request(`/${INSTANCE_ID}/transitions`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });
});

describe("GET /entities/:id/events", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with ordered event log", async () => {
    mockGetWorkflowEventLog.mockResolvedValue([fakeEvent]);

    const res = await makeApp().request(`/${INSTANCE_ID}/events`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].toState).toBe("in_progress");
    expect(mockGetWorkflowEventLog).toHaveBeenCalledWith(
      {},
      "t-aaa",
      INSTANCE_ID,
    );
  });

  it("returns empty list when instance has no events", async () => {
    mockGetWorkflowEventLog.mockResolvedValue([]);

    const res = await makeApp().request(`/${INSTANCE_ID}/events`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });
});
