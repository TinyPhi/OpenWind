import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSetEntityState = vi.fn();

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
  withTenantContext: (tenantId, fn) => fn({}),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    setEntityState: (...args: unknown[]) => mockSetEntityState(...args),
  };
});

const { setEntityStateHandler } = await import("./set-state.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/state", ...setEntityStateHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INST_ID = "00000000-0000-0000-0000-000000000002";

const fakeInstance = {
  id: INST_ID,
  entityTypeId: "00000000-0000-0000-0000-000000000001",
  tenantId: "t-aaa",
  workflowId: null,
  currentState: "closed",
  fields: {},
  createdBy: null,
  assignedTo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /entities/:id/state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with the updated instance when state change succeeds", async () => {
    mockSetEntityState.mockResolvedValue(fakeInstance);

    const res = await makeApp().request(`/${INST_ID}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.currentState).toBe("closed");
    expect(mockSetEntityState).toHaveBeenCalledWith(
      {},
      "t-aaa",
      INST_ID,
      "closed",
      "u-bbb",
    );
  });

  it("returns 400 when state is an empty string", async () => {
    const res = await makeApp().request(`/${INST_ID}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "" }),
    });

    expect(res.status).toBe(400);
    expect(mockSetEntityState).not.toHaveBeenCalled();
  });

  it("returns 400 when state is missing from the body", async () => {
    const res = await makeApp().request(`/${INST_ID}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(mockSetEntityState).not.toHaveBeenCalled();
  });

  it("returns 404 when the entity does not exist", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockSetEntityState.mockRejectedValue(new EntityError("ENTITY_NOT_FOUND"));

    const res = await makeApp().request(`/${INST_ID}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "open" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("ENTITY_NOT_FOUND");
  });

  it("returns 404 for a soft-deleted entity", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockSetEntityState.mockRejectedValue(new EntityError("ENTITY_NOT_FOUND"));

    const res = await makeApp().request(`/${INST_ID}/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "open" }),
    });

    expect(res.status).toBe(404);
  });
});
