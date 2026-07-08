import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Mocks ─────────────────────────────────────────────────────────────────────

let currentAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["user"],
  email: "test@example.com",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", currentAuth);
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

const mockGetParentId = vi.fn();
const mockUpdateEntity = vi.fn();

vi.mock("@platform/entity-engine", () => ({
  getParentId: (...args: unknown[]) => mockGetParentId(...args),
  updateEntity: (...args: unknown[]) => mockUpdateEntity(...args),
}));

let childRow: {
  assignedTo: string | null;
  createdBy: string | null;
  fields: Record<string, unknown>;
} | null = null;

const mockTx = {
  select: () => mockTx,
  from: () => mockTx,
  where: () => mockTx,
  limit: () => Promise.resolve(childRow ? [childRow] : []),
};

vi.mock("@platform/db", () => ({
  db: {},
  entityInstances: {
    id: "entity_instances.id",
    tenantId: "entity_instances.tenant_id",
    assignedTo: "entity_instances.assigned_to",
    createdBy: "entity_instances.created_by",
    fields: "entity_instances.fields",
  },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

const { setChildStatusHandler } = await import("./set-child-status.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.patch("/:id/child-status", ...setChildStatusHandler);
  return app;
}

const INST_ID = "00000000-0000-0000-0000-000000000002";
const PARENT_ID = "00000000-0000-0000-0000-000000000001";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /entities/:id/child-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childRow = null;
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles: ["user"],
      email: "test@example.com",
    };
    mockGetParentId.mockResolvedValue(PARENT_ID);
    mockUpdateEntity.mockResolvedValue({ id: INST_ID, currentState: "closed" });
  });

  it("returns 404 for a non-privileged user with no relationship to the ticket", async () => {
    childRow = {
      assignedTo: "someone-else",
      createdBy: "someone-else",
      fields: {},
    };

    const res = await makeApp().request(`/${INST_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    expect(res.status).toBe(404);
    expect(mockUpdateEntity).not.toHaveBeenCalled();
  });

  it("allows the assignee to change status", async () => {
    childRow = { assignedTo: "u-bbb", createdBy: "someone-else", fields: {} };

    const res = await makeApp().request(`/${INST_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateEntity).toHaveBeenCalled();
  });

  it("allows the creator to change status", async () => {
    childRow = { assignedTo: "someone-else", createdBy: "u-bbb", fields: {} };

    const res = await makeApp().request(`/${INST_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateEntity).toHaveBeenCalled();
  });

  it("allows a user with a read_write __accessUsers grant to change status", async () => {
    childRow = {
      assignedTo: "someone-else",
      createdBy: "someone-else",
      fields: { __accessUsers: { "u-bbb": { level: "read_write" } } },
    };

    const res = await makeApp().request(`/${INST_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    expect(res.status).toBe(200);
  });

  it("rejects a read_comment-only grant — commenting access is not write access", async () => {
    childRow = {
      assignedTo: "someone-else",
      createdBy: "someone-else",
      fields: { __accessUsers: { "u-bbb": { level: "read_comment" } } },
    };

    const res = await makeApp().request(`/${INST_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    expect(res.status).toBe(404);
    expect(mockUpdateEntity).not.toHaveBeenCalled();
  });

  it("skips the ownership check for privileged roles", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-admin",
      roles: ["admin"],
      email: "admin@example.com",
    };
    childRow = {
      assignedTo: "someone-else",
      createdBy: "someone-else",
      fields: {},
    };

    const res = await makeApp().request(`/${INST_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateEntity).toHaveBeenCalled();
  });

  it("returns 422 when the instance is not a child ticket", async () => {
    mockGetParentId.mockResolvedValue(null);

    const res = await makeApp().request(`/${INST_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    expect(res.status).toBe(422);
  });
});
