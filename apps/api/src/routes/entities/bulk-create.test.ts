import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Hoisted mutable auth fixture ──────────────────────────────────────────────

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["agent"] as string[],
    email: "test@example.com",
  },
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth as AuthContext);
      await next();
    },
  requireRole:
    (..._roles: string[]) =>
    async (_c: Context, next: Next) => {
      await next();
    },
}));

const mockBulkCreateEntities = vi.fn();
vi.mock("@platform/entity-engine", () => ({
  bulkCreateEntities: (...args: unknown[]) => mockBulkCreateEntities(...args),
  BULK_MAX_ITEMS: 100,
}));

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

vi.mock("../../lib/handle-entity-error.js", () => ({
  handleEntityError: (_c: unknown, err: unknown) => {
    throw err;
  },
}));

const { bulkCreateHandler } = await import("./bulk-create.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/", ...bulkCreateHandler);
  return app;
}

const VALID_ITEM = {
  entityTypeId: "11111111-1111-1111-1111-111111111111",
  fields: { title: "test" },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /entities/bulk — createdBy injection (#229)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBulkCreateEntities.mockResolvedValue([{ id: "e-1" }, { id: "e-2" }]);
  });

  it("returns 201 with bulk result", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [VALID_ITEM] }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data).toBeDefined();
  });

  it("injects auth userId as createdBy — ignores any createdBy in request body", async () => {
    await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            ...VALID_ITEM,
            createdBy: "attacker-id",
          },
        ],
      }),
    });

    expect(mockBulkCreateEntities).toHaveBeenCalledOnce();
    const calledItems = mockBulkCreateEntities.mock.calls[0][2];
    expect(calledItems[0].createdBy).toBe("u-bbb");
    expect(calledItems[0].createdBy).not.toBe("attacker-id");
  });

  it("sets createdBy from auth on every item in the batch", async () => {
    await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [VALID_ITEM, VALID_ITEM, VALID_ITEM],
      }),
    });

    const calledItems = mockBulkCreateEntities.mock.calls[0][2];
    expect(calledItems).toHaveLength(3);
    for (const item of calledItems) {
      expect(item.createdBy).toBe("u-bbb");
    }
  });

  it("passes tenantId from auth to bulkCreateEntities", async () => {
    await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [VALID_ITEM] }),
    });

    expect(mockBulkCreateEntities).toHaveBeenCalledWith(
      expect.anything(),
      "t-aaa",
      expect.any(Array),
    );
  });

  it("returns 400 for an empty items array", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(400);
    expect(mockBulkCreateEntities).not.toHaveBeenCalled();
  });
});
