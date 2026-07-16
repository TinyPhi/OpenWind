import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

vi.mock("drizzle-orm", () => {
  const noop = vi.fn(() => "sql");
  const sqlFn = Object.assign(
    (_strings: TemplateStringsArray, ..._vals: unknown[]) => "sql",
    { join: vi.fn(() => "sql") },
  );
  return { eq: noop, and: noop, sql: sqlFn };
});

const mockAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-admin",
  roles: ["admin"],
  email: "admin@example.com",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth);
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

const mockEmitAccessEvent = vi.fn();
vi.mock("../../lib/emit-access-event.js", () => ({
  emitAccessEvent: (...args: unknown[]) => mockEmitAccessEvent(...args),
}));

vi.mock("../../lib/handle-entity-error.js", () => ({
  handleEntityError: (_c: unknown, err: unknown) => {
    throw err;
  },
}));

const entityInstancesTable = {
  id: "entity_instances.id",
  tenantId: "entity_instances.tenant_id",
};
const tenantUsersTable = {
  userId: "tenant_users.user_id",
  tenantId: "tenant_users.tenant_id",
};

const INST_ID = "00000000-0000-0000-0000-000000000002";

let instanceExists: boolean;
let tenantUserExists: boolean;
let currentFromTable: unknown;

const mockTx = {
  select: () => mockTx,
  from: (table: unknown) => {
    currentFromTable = table;
    return mockTx;
  },
  where: () => mockTx,
  limit: () => {
    if (currentFromTable === tenantUsersTable) {
      return Promise.resolve(
        tenantUserExists ? [{ userId: "target-user" }] : [],
      );
    }
    return Promise.resolve(instanceExists ? [{ id: INST_ID }] : []);
  },
  update: () => ({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  }),
};

vi.mock("@platform/db", () => ({
  entityInstances: entityInstancesTable,
  tenantUsers: tenantUsersTable,
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

const { grantAccessHandler } = await import("./grant-access.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/access", ...grantAccessHandler);
  return app;
}

describe("POST /entities/:id/access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentFromTable = undefined;
    instanceExists = true;
    tenantUserExists = true;
  });

  it("grants access to a userId that is an actual tenant member", async () => {
    const res = await makeApp().request(`/${INST_ID}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "target-user", level: "read_write" }),
    });

    expect(res.status).toBe(201);
    expect(mockEmitAccessEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects a userId that is not a member of this tenant", async () => {
    tenantUserExists = false;

    const res = await makeApp().request(`/${INST_ID}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "not-a-member", level: "read_write" }),
    });

    expect(res.status).toBe(404);
    expect(mockEmitAccessEvent).not.toHaveBeenCalled();
  });

  it("returns 404 when the record does not exist", async () => {
    instanceExists = false;

    const res = await makeApp().request(`/${INST_ID}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "target-user" }),
    });

    expect(res.status).toBe(404);
    expect(mockEmitAccessEvent).not.toHaveBeenCalled();
  });
});
