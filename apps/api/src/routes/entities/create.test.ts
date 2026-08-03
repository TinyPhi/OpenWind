import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCreateEntity = vi.fn();
const mockListUserIdsWithRole = vi.fn();

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: "t-aaa",
        userId: "u-bbb",
        roles: ["admin"],
        email: "test@example.com",
        orgId: "org-ccc",
      });
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("../../lib/zitadel-management.js", () => ({
  listUserIdsWithRole: (...args: unknown[]) => mockListUserIdsWithRole(...args),
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockListUserIdsWithRole.mockResolvedValue(new Set());
  });

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

describe("POST /entities — assignedTo validation (R3)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("succeeds when assignedTo is a real tenant member holding the 'user' role", async () => {
    mockListUserIdsWithRole.mockResolvedValue(new Set(["u-target"]));
    mockCreateEntity.mockResolvedValue(fakeInstance);

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validBody({ assignedTo: "u-target" }),
    });

    expect(res.status).toBe(201);
    expect(mockListUserIdsWithRole).toHaveBeenCalledWith("org-ccc", "user");
    expect(mockCreateEntity).toHaveBeenCalled();
  });

  it("returns 422 when assignedTo does not exist / isn't a 'user'-role member", async () => {
    mockListUserIdsWithRole.mockResolvedValue(new Set(["some-other-user"]));

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validBody({ assignedTo: "u-nonexistent" }),
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.fields.assignedTo).toBeDefined();
    expect(mockCreateEntity).not.toHaveBeenCalled();
  });

  it("returns 422 when assignedTo is an agent/admin account (not in the role='user' set)", async () => {
    // listUserIdsWithRole(orgId, "user") only ever returns role="user" ids —
    // an agent/admin id simply never appears in this set.
    mockListUserIdsWithRole.mockResolvedValue(new Set(["u-some-user"]));

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validBody({ assignedTo: "u-agent-account" }),
    });

    expect(res.status).toBe(422);
    expect(mockCreateEntity).not.toHaveBeenCalled();
  });

  it("returns 422 for a cross-tenant assignedTo id (not present in this org's role set)", async () => {
    mockListUserIdsWithRole.mockResolvedValue(new Set(["u-same-tenant"]));

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validBody({ assignedTo: "u-other-tenant-user" }),
    });

    expect(res.status).toBe(422);
    expect(mockCreateEntity).not.toHaveBeenCalled();
  });

  it("does not call listUserIdsWithRole when assignedTo is omitted", async () => {
    mockCreateEntity.mockResolvedValue(fakeInstance);

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: validBody(),
    });

    expect(res.status).toBe(201);
    expect(mockListUserIdsWithRole).not.toHaveBeenCalled();
  });
});
