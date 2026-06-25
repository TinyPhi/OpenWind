import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockUpdateEntity = vi.fn();

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

const mockDb = {
  select: () => mockDb,
  from: () => mockDb,
  where: () => mockDb,
  limit: () => Promise.resolve([]),
};

vi.mock("@platform/db", () => ({
  db: mockDb,
  tenantUsers: {},
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    updateEntity: (...args: unknown[]) => mockUpdateEntity(...args),
  };
});

const { updateEntityHandler } = await import("./update.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.patch("/:id", ...updateEntityHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INST_ID = "00000000-0000-0000-0000-000000000002";

function makeInstance(fields: Record<string, unknown> = {}) {
  return {
    id: INST_ID,
    entityTypeId: "00000000-0000-0000-0000-000000000001",
    tenantId: "t-aaa",
    workflowId: null,
    currentState: "open",
    fields,
    createdBy: null,
    assignedTo: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /entities/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with the updated instance when validation passes", async () => {
    mockUpdateEntity.mockResolvedValue(makeInstance({ subject: "updated" }));

    const res = await makeApp().request(`/${INST_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { subject: "updated" } }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.fields.subject).toBe("updated");
    expect(mockUpdateEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "t-aaa",
      INST_ID,
      expect.objectContaining({ fields: { subject: "updated" } }),
    );
  });

  it("accepts an empty object (no-op update) without error", async () => {
    mockUpdateEntity.mockResolvedValue(makeInstance());

    const res = await makeApp().request(`/${INST_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
  });

  it("returns 422 when the engine throws a ValidationError", async () => {
    const { ValidationError } = await import("@platform/entity-engine");
    mockUpdateEntity.mockRejectedValue(
      new ValidationError([
        { field: "subject", code: "too_big", message: "Too long" },
      ]),
    );

    const res = await makeApp().request(`/${INST_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { subject: "x".repeat(1000) } }),
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when the entity does not exist", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockUpdateEntity.mockRejectedValue(new EntityError("ENTITY_NOT_FOUND"));

    const res = await makeApp().request(`/${INST_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { subject: "x" } }),
    });

    expect(res.status).toBe(404);
  });

  it("allows setting assignedTo to null (unassign)", async () => {
    mockUpdateEntity.mockResolvedValue(makeInstance());

    const res = await makeApp().request(`/${INST_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedTo: null }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateEntity).toHaveBeenCalledWith(
      expect.any(Object),
      "t-aaa",
      INST_ID,
      expect.objectContaining({ assignedTo: null }),
    );
  });
});
