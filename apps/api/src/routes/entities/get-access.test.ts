import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Mocks ─────────────────────────────────────────────────────────────────────

let mockAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["agent"],
  email: "test@example.com",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth);
      await next();
    },
}));

let mockInstance: {
  fields: unknown;
  assignedTo: string | null;
  createdBy: string | null;
} | null = null;

vi.mock("@platform/db", () => ({
  entityInstances: {
    id: "entity_instances.id",
    tenantId: "entity_instances.tenant_id",
    fields: "entity_instances.fields",
    assignedTo: "entity_instances.assigned_to",
    createdBy: "entity_instances.created_by",
  },
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(mockInstance ? [mockInstance] : []),
          }),
        }),
      }),
    }),
}));

const { getAccessHandler } = await import("./get-access.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/:id/access", ...getAccessHandler);
  return app;
}

const INST_ID = "00000000-0000-0000-0000-000000000002";

describe("GET /entities/:id/access", () => {
  beforeEach(() => {
    mockAuth = {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles: ["agent"],
      email: "test@example.com",
    };
    mockInstance = null;
  });

  it("returns 404 for a non-privileged user with no relation to the record", async () => {
    mockAuth = {
      tenantId: "t-aaa",
      userId: "u-outsider",
      roles: ["user"],
      email: "outsider@example.com",
    };
    mockInstance = {
      fields: { subject: "hello" },
      createdBy: "u-owner",
      assignedTo: "u-other",
    };

    const res = await makeApp().request(`/${INST_ID}/access`);

    expect(res.status).toBe(404);
  });

  it("returns 200 with the ACL for the record's creator", async () => {
    mockAuth = {
      tenantId: "t-aaa",
      userId: "u-owner",
      roles: ["user"],
      email: "owner@example.com",
    };
    mockInstance = {
      fields: { subject: "hello" },
      createdBy: "u-owner",
      assignedTo: null,
    };

    const res = await makeApp().request(`/${INST_ID}/access`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([
      { userId: "u-owner", level: "read_write", tag: "creator" },
    ]);
  });

  it("returns 200 for an admin regardless of ownership", async () => {
    mockAuth = {
      tenantId: "t-aaa",
      userId: "u-admin",
      roles: ["admin"],
      email: "admin@example.com",
    };
    mockInstance = {
      fields: { subject: "hello" },
      createdBy: "u-owner",
      assignedTo: "u-other",
    };

    const res = await makeApp().request(`/${INST_ID}/access`);

    expect(res.status).toBe(200);
  });

  it("returns 404 when the record does not exist", async () => {
    mockInstance = null;

    const res = await makeApp().request(`/${INST_ID}/access`);

    expect(res.status).toBe(404);
  });
});
