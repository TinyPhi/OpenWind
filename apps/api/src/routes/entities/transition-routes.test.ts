import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngineModule from "@platform/workflow-engine";
import type * as EntityEngineModule from "@platform/entity-engine";

const engine = {
  executeTransition: vi.fn(),
  getAvailableTransitions: vi.fn(),
  getWorkflowEventLog: vi.fn(),
  getEntity: vi.fn(),
  hasEntityAccess: vi.fn(),
  withTenantContext: vi.fn(),
};

const authState: { current: AuthContext | null } = { current: null };

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      if (!authState.current) {
        return c.json({ error: "UNAUTHORIZED", message: "Missing token" }, 401);
      }
      c.set("auth", authState.current);
      await next();
    },
  requireRole:
    (...allowed: string[]) =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      if (!c.get("auth").roles.some((r) => allowed.includes(r))) {
        return c.json({ error: "FORBIDDEN", message: "Forbidden" }, 403);
      }
      await next();
    },
}));

vi.mock("@platform/db", () => ({
  db: {},
  tenantUsers: { userId: {}, displayName: {}, email: {} },
  withTenantContext: (...args: unknown[]) => engine.withTenantContext(...args),
}));

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngineModule>();
  return {
    ...real,
    executeTransition: (...args: unknown[]) =>
      engine.executeTransition(...args),
    getAvailableTransitions: (...args: unknown[]) =>
      engine.getAvailableTransitions(...args),
    getWorkflowEventLog: (...args: unknown[]) =>
      engine.getWorkflowEventLog(...args),
  };
});

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngineModule>();
  return {
    ...real,
    getEntity: (...args: unknown[]) => engine.getEntity(...args),
  };
});

vi.mock("../../lib/entity-access.js", () => ({
  hasEntityAccess: (...args: unknown[]) => engine.hasEntityAccess(...args),
}));

vi.mock("../../lib/zitadel-management.js", () => ({
  listOrgUsers: vi.fn().mockResolvedValue([]),
  getUserById: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../lib/resolve-origin-display.js", () => ({
  batchLookupApplicationNames: vi.fn().mockResolvedValue(new Map()),
  batchLookupPerformerNames: vi.fn().mockResolvedValue(new Map()),
  toOriginDisplay: vi.fn().mockReturnValue(null),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { WorkflowError } = await import("@platform/workflow-engine");
const { EntityError } = await import("@platform/entity-engine");
const { executeTransitionHandler } = await import("./execute-transition.js");
const { listTransitionsHandler } = await import("./list-transitions.js");
const { listWorkflowEventsHandler } = await import("./list-workflow-events.js");

const TENANT = "aaaaaaaa-0733-4000-a000-000000000001";
const OTHER_TENANT = "bbbbbbbb-0733-4000-b000-000000000002";
const ACTOR = "user-actor-1";
const RECORD_ID = "11111111-2222-4333-8444-555555555555";
const TRANSITION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const tenantUserRows = [
  { userId: ACTOR, displayName: "Asha Rao", email: "asha@example.com" },
];

const fakeTx = {
  select: vi.fn(() => ({
    from: () => ({ where: () => Promise.resolve(tenantUserRows) }),
  })),
};

function authAs(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    tenantId: TENANT,
    userId: ACTOR,
    roles: ["agent"],
    email: "actor@example.com",
    displayName: "Actor",
    ...overrides,
  };
}

function buildApp(): Hono<{ Variables: { auth: AuthContext } }> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/:id/transitions/history", ...listWorkflowEventsHandler);
  app.get("/:id/transitions", ...listTransitionsHandler);
  app.post("/:id/transitions", ...executeTransitionHandler);
  return app;
}

function postTransition(body: unknown): Promise<Response> {
  return Promise.resolve(
    buildApp().request(`/${RECORD_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function get(path: string): Promise<Response> {
  return Promise.resolve(buildApp().request(path));
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.current = authAs();
  engine.withTenantContext.mockImplementation(
    (_tenantId: string, fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx),
  );
  engine.getEntity.mockResolvedValue({
    id: RECORD_ID,
    createdBy: ACTOR,
    assignedTo: null,
    fields: {},
  });
  engine.hasEntityAccess.mockResolvedValue(true);
});

describe("POST /:id/transitions", () => {
  const recordedEvent = {
    id: "evt-1",
    instanceId: RECORD_ID,
    fromState: "new",
    toState: "triaged",
    triggeredBy: "user",
    actorId: ACTOR,
    metadata: {},
  };

  it("returns 201 with the recorded workflow event", async () => {
    engine.executeTransition.mockResolvedValue(recordedEvent);

    const res = await postTransition({
      transitionId: TRANSITION_ID,
      comment: "moving on",
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: recordedEvent });
    expect(engine.executeTransition).toHaveBeenCalledWith(fakeTx, TENANT, {
      instanceId: RECORD_ID,
      transitionId: TRANSITION_ID,
      actorId: ACTOR,
      actorRoles: ["agent"],
      triggeredBy: "user",
      comment: "moving on",
    });
  });

  it("runs the engine call inside the caller's tenant context", async () => {
    const order: string[] = [];
    engine.withTenantContext.mockImplementation(
      async (tenantId: string, fn: (tx: typeof fakeTx) => unknown) => {
        order.push(`enter:${tenantId}`);
        const out = await fn(fakeTx);
        order.push("exit");
        return out;
      },
    );
    engine.executeTransition.mockImplementation(async () => {
      order.push("engine");
      return recordedEvent;
    });

    await postTransition({ transitionId: TRANSITION_ID });

    expect(order).toEqual([`enter:${TENANT}`, "engine", "exit"]);
    expect(engine.executeTransition.mock.calls[0]?.[0]).toBe(fakeTx);
  });

  it("forwards the idempotency key and caller metadata to the engine", async () => {
    engine.executeTransition.mockResolvedValue(recordedEvent);

    await postTransition({
      transitionId: TRANSITION_ID,
      idempotencyKey: "retry-key-42",
      metadata: { source: "mobile" },
    });

    expect(engine.executeTransition).toHaveBeenCalledWith(
      fakeTx,
      TENANT,
      expect.objectContaining({
        idempotencyKey: "retry-key-42",
        metadata: { source: "mobile" },
      }),
    );
  });

  it("omits optional keys from the engine request when the body leaves them out", async () => {
    engine.executeTransition.mockResolvedValue(recordedEvent);

    await postTransition({ transitionId: TRANSITION_ID });

    const request: unknown = engine.executeTransition.mock.calls[0]?.[2];
    expect(request).not.toHaveProperty("comment");
    expect(request).not.toHaveProperty("idempotencyKey");
    expect(request).not.toHaveProperty("metadata");
  });

  it.each([
    ["the body has no transitionId", { comment: "hi" }],
    ["transitionId is not a UUID", { transitionId: "abc" }],
    [
      "idempotencyKey is empty",
      { transitionId: TRANSITION_ID, idempotencyKey: "" },
    ],
    [
      "idempotencyKey exceeds 255 characters",
      { transitionId: TRANSITION_ID, idempotencyKey: "k".repeat(256) },
    ],
  ])("rejects with 400 when %s", async (_label, body) => {
    const res = await postTransition(body);

    expect(res.status).toBe(400);
    expect(engine.executeTransition).not.toHaveBeenCalled();
  });

  it.each([
    ["INSTANCE_NOT_FOUND", 404],
    ["TRANSITION_NOT_AVAILABLE", 409],
    ["TRANSITION_FORBIDDEN", 403],
  ] as const)("maps %s from the engine to HTTP %i", async (code, status) => {
    engine.executeTransition.mockRejectedValue(new WorkflowError(code));

    const res = await postTransition({ transitionId: TRANSITION_ID });

    expect(res.status).toBe(status);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ error: code });
  });

  it("maps TRANSITION_LOCKED to 409 with a Retry-After header", async () => {
    engine.executeTransition.mockRejectedValue(
      new WorkflowError("TRANSITION_LOCKED"),
    );

    const res = await postTransition({ transitionId: TRANSITION_ID });

    expect(res.status).toBe(409);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.json()).toMatchObject({ error: "TRANSITION_LOCKED" });
  });

  it("maps CONDITION_NOT_MET to 422 and passes the condition meta through", async () => {
    engine.executeTransition.mockRejectedValue(
      new WorkflowError("CONDITION_NOT_MET", { field: "priority" }),
    );

    const res = await postTransition({ transitionId: TRANSITION_ID });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "CONDITION_NOT_MET",
      meta: { field: "priority" },
    });
  });

  it("maps REQUIRED_FIELDS_MISSING to 422 and lists the missing fields", async () => {
    engine.executeTransition.mockRejectedValue(
      new WorkflowError("REQUIRED_FIELDS_MISSING", {
        missing: ["resolution", "rootCause"],
      }),
    );

    const res = await postTransition({ transitionId: TRANSITION_ID });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "REQUIRED_FIELDS_MISSING",
      fields: ["resolution", "rootCause"],
    });
  });

  it("rejects an unauthenticated caller before reaching the engine", async () => {
    authState.current = null;

    const res = await postTransition({ transitionId: TRANSITION_ID });

    expect(res.status).toBe(401);
    expect(engine.executeTransition).not.toHaveBeenCalled();
  });

  it("rejects a caller without an admin, agent or user role", async () => {
    authState.current = authAs({ roles: ["viewer"] });

    const res = await postTransition({ transitionId: TRANSITION_ID });

    expect(res.status).toBe(403);
    expect(engine.executeTransition).not.toHaveBeenCalled();
  });
});

describe("GET /:id/transitions", () => {
  const available = [
    {
      id: TRANSITION_ID,
      fromState: "new",
      toState: "triaged",
      label: "Triage",
    },
  ];

  it("returns the transitions available to the caller", async () => {
    engine.getAvailableTransitions.mockResolvedValue(available);

    const res = await get(`/${RECORD_ID}/transitions`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: available });
  });

  it("returns an empty list when nothing is available from the current state", async () => {
    engine.getAvailableTransitions.mockResolvedValue([]);

    const res = await get(`/${RECORD_ID}/transitions`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("asks the engine using the caller's tenant, the record id and the caller's roles", async () => {
    authState.current = authAs({ roles: ["agent", "user"] });
    engine.getAvailableTransitions.mockResolvedValue([]);

    await get(`/${RECORD_ID}/transitions`);

    expect(engine.withTenantContext).toHaveBeenCalledWith(
      TENANT,
      expect.any(Function),
    );
    expect(engine.getEntity).toHaveBeenCalledWith(fakeTx, TENANT, RECORD_ID);
    expect(engine.getAvailableTransitions).toHaveBeenCalledWith(
      fakeTx,
      TENANT,
      RECORD_ID,
      ["agent", "user"],
    );
  });

  it("narrows actor roles to the requested subset the caller actually holds", async () => {
    authState.current = authAs({ roles: ["agent", "user"] });
    engine.getAvailableTransitions.mockResolvedValue([]);

    await get(`/${RECORD_ID}/transitions?roles=user, admin`);

    expect(engine.getAvailableTransitions).toHaveBeenCalledWith(
      fakeTx,
      TENANT,
      RECORD_ID,
      ["user"],
    );
  });

  // RLS hides another tenant's row, so getEntity fails before transitions are read.
  it("returns 404 for another tenant's record without querying transitions", async () => {
    authState.current = authAs({ tenantId: OTHER_TENANT });
    engine.getEntity.mockRejectedValue(new EntityError("ENTITY_NOT_FOUND"));

    const res = await get(`/${RECORD_ID}/transitions`);

    expect(res.status).toBe(404);
    expect(engine.getEntity).toHaveBeenCalledWith(
      fakeTx,
      OTHER_TENANT,
      RECORD_ID,
    );
    expect(engine.getAvailableTransitions).not.toHaveBeenCalled();
    for (const call of engine.withTenantContext.mock.calls) {
      expect(call[0]).toBe(OTHER_TENANT);
    }
  });

  it("returns 404 without querying transitions when the caller lacks record access", async () => {
    engine.hasEntityAccess.mockResolvedValue(false);

    const res = await get(`/${RECORD_ID}/transitions`);

    expect(res.status).toBe(404);
    expect(engine.getAvailableTransitions).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    authState.current = null;

    const res = await get(`/${RECORD_ID}/transitions`);

    expect(res.status).toBe(401);
    expect(engine.getAvailableTransitions).not.toHaveBeenCalled();
  });
});

describe("GET /:id/transitions/history", () => {
  const historyEvent = {
    id: "evt-9",
    instanceId: RECORD_ID,
    fromState: "new",
    toState: "triaged",
    triggeredBy: "user",
    actorId: ACTOR,
    comment: null,
    metadata: {},
  };

  it("returns the event log enriched with the actor's display name", async () => {
    engine.getWorkflowEventLog.mockResolvedValue([historyEvent]);

    const res = await get(`/${RECORD_ID}/transitions/history`);

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({
      data: [
        expect.objectContaining({
          id: "evt-9",
          toState: "triaged",
          actorDisplayName: "Asha Rao",
          origin: null,
        }),
      ],
    });
    expect(engine.getWorkflowEventLog).toHaveBeenCalledWith(
      fakeTx,
      TENANT,
      RECORD_ID,
    );
  });

  it("returns an empty list when the record has no history", async () => {
    engine.getWorkflowEventLog.mockResolvedValue([]);

    const res = await get(`/${RECORD_ID}/transitions/history`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(fakeTx.select).not.toHaveBeenCalled();
  });

  // RLS hides another tenant's row, so getEntity fails before any event is read.
  it("returns 404 for another tenant's record without reading its log", async () => {
    authState.current = authAs({ tenantId: OTHER_TENANT });
    engine.getEntity.mockRejectedValue(new EntityError("ENTITY_NOT_FOUND"));

    const res = await get(`/${RECORD_ID}/transitions/history`);

    expect(res.status).toBe(404);
    expect(engine.getEntity).toHaveBeenCalledWith(
      fakeTx,
      OTHER_TENANT,
      RECORD_ID,
    );
    expect(engine.getWorkflowEventLog).not.toHaveBeenCalled();
    for (const call of engine.withTenantContext.mock.calls) {
      expect(call[0]).toBe(OTHER_TENANT);
    }
  });

  it("returns 404 without reading the log when the caller lacks record access", async () => {
    engine.hasEntityAccess.mockResolvedValue(false);

    const res = await get(`/${RECORD_ID}/transitions/history`);

    expect(res.status).toBe(404);
    expect(engine.getWorkflowEventLog).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    authState.current = null;

    const res = await get(`/${RECORD_ID}/transitions/history`);

    expect(res.status).toBe(401);
    expect(engine.getWorkflowEventLog).not.toHaveBeenCalled();
  });
});
