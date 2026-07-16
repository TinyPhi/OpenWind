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
  requireRole:
    (...allowed: string[]) =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      const roles = c.get("auth").roles;
      if (!allowed.some((r) => roles.includes(r))) {
        return c.json(
          { error: "FORBIDDEN", message: "Insufficient permissions" },
          403,
        );
      }
      await next();
    },
}));

const mockGetParentId = vi.fn();
const mockUpdateEntity = vi.fn();

vi.mock("@platform/entity-engine", () => ({
  getParentId: (...args: unknown[]) => mockGetParentId(...args),
  updateEntity: (...args: unknown[]) => mockUpdateEntity(...args),
}));

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
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
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles: ["user"],
      email: "test@example.com",
    };
    mockGetParentId.mockResolvedValue(PARENT_ID);
    mockUpdateEntity.mockResolvedValue({ id: INST_ID, currentState: "closed" });
  });

  // H-3: this endpoint is a deliberate #127-class workflow-engine bypass
  // (direct current_state mutation, no transition validation, no
  // automation trigger). Restricted to admin/agent — the ticket
  // owner/assignee/read_write-ACL side-door from the reviewed PR is gone.
  it("rejects a plain user role even when they are the assignee/creator", async () => {
    const res = await makeApp().request(`/${INST_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    expect(res.status).toBe(403);
    expect(mockUpdateEntity).not.toHaveBeenCalled();
  });

  it("allows admin to change status", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-admin",
      roles: ["admin"],
      email: "admin@example.com",
    };

    const res = await makeApp().request(`/${INST_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateEntity).toHaveBeenCalled();
  });

  it("allows agent to change status", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-agent",
      roles: ["agent"],
      email: "agent@example.com",
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
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-admin",
      roles: ["admin"],
      email: "admin@example.com",
    };
    mockGetParentId.mockResolvedValue(null);

    const res = await makeApp().request(`/${INST_ID}/child-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });

    expect(res.status).toBe(422);
  });
});
