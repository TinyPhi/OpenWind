import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCreateEntity = vi.fn();

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

const mockTx = {
  select: () => mockTx,
  from: () => mockTx,
  where: () => mockTx,
  limit: () => Promise.resolve([]),
};

vi.mock("@platform/db", () => ({
  db: {},
  tenantUsers: {},
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    createEntity: (...args: unknown[]) => mockCreateEntity(...args),
  };
});

const { createEntityHandler } = await import("./create.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/", ...createEntityHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TYPE_ID = "00000000-0000-0000-0000-000000000001";

const fakeInstance = {
  id: "inst-1",
  entityTypeId: TYPE_ID,
  tenantId: "t-aaa",
  workflowId: null,
  currentState: "initial",
  fields: { subject: "hello" },
  createdBy: null,
  assignedTo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

function validBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    entityTypeId: TYPE_ID,
    fields: { subject: "hello" },
    ...overrides,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /entities", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 201 with the created instance on success", async () => {
    mockCreateEntity.mockResolvedValue(fakeInstance);

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validBody(),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.id).toBe("inst-1");
    expect(mockCreateEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "t-aaa",
      expect.objectContaining({ entityTypeId: TYPE_ID }),
    );
  });

  it("returns 400 when entityTypeId is not a valid UUID", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityTypeId: "not-a-uuid", fields: {} }),
    });

    expect(res.status).toBe(400);
    expect(mockCreateEntity).not.toHaveBeenCalled();
  });

  it("returns 400 when fields is missing from the body", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityTypeId: TYPE_ID }),
    });

    expect(res.status).toBe(400);
    expect(mockCreateEntity).not.toHaveBeenCalled();
  });

  it("returns 422 when the engine throws a ValidationError", async () => {
    const { ValidationError } = await import("@platform/entity-engine");
    mockCreateEntity.mockRejectedValue(
      new ValidationError([
        { field: "subject", code: "required", message: "Required" },
      ]),
    );

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validBody(),
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.fields).toHaveLength(1);
  });

  it("returns 404 when the entity type does not exist", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockCreateEntity.mockRejectedValue(
      new EntityError("ENTITY_TYPE_NOT_FOUND"),
    );

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validBody(),
    });

    expect(res.status).toBe(404);
  });
});
