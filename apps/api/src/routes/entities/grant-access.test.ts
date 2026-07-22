import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// Captures the last `eq(tenantUsers.userId, <value>)` call so the mock tx
// below can prove the tenant-membership lookup targets the grant's target
// userId, not the actor's — a mock that ignores this argument would still
// pass even if the handler queried `actorId` instead of the target `userId`.
let lastTenantUsersUserIdQueried: unknown;

vi.mock("drizzle-orm", () => {
  const eqFn = vi.fn((col: unknown, val: unknown) => {
    if (col === "tenant_users.user_id") lastTenantUsersUserIdQueried = val;
    return "sql";
  });
  const andFn = vi.fn(() => "sql");
  const sqlFn = Object.assign(
    (_strings: TemplateStringsArray, ..._vals: unknown[]) => "sql",
    { join: vi.fn(() => "sql") },
  );
  return { eq: eqFn, and: andFn, sql: sqlFn };
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
let expectedTargetUserId: string;

const mockTx = {
  select: () => mockTx,
  from: (table: unknown) => {
    currentFromTable = table;
    return mockTx;
  },
  where: () => mockTx,
  limit: () => {
    if (currentFromTable === tenantUsersTable) {
      // Only "found" when the lookup actually queried the expected target
      // userId — proves the handler validates input.userId, not the actor's.
      const found =
        tenantUserExists &&
        lastTenantUsersUserIdQueried === expectedTargetUserId;
      return Promise.resolve(found ? [{ userId: expectedTargetUserId }] : []);
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
    expectedTargetUserId = "target-user";
    lastTenantUsersUserIdQueried = undefined;
  });

  it("grants access to a userId that is an actual tenant member", async () => {
    const res = await makeApp().request(`/${INST_ID}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "target-user", level: "read_write" }),
    });

    expect(res.status).toBe(201);
    expect(mockEmitAccessEvent).toHaveBeenCalledTimes(1);
    expect(lastTenantUsersUserIdQueried).toBe("target-user");
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

  it("checks the tenant-membership lookup against the grant target, not the authenticated actor", async () => {
    // mockAuth.userId is "u-admin" — if the handler mistakenly queried the
    // actor's userId instead of input.userId, this test's target
    // ("target-user") would never match and the grant would 404 incorrectly.
    expectedTargetUserId = "target-user";

    const res = await makeApp().request(`/${INST_ID}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "target-user", level: "read_write" }),
    });

    expect(lastTenantUsersUserIdQueried).toBe("target-user");
    expect(lastTenantUsersUserIdQueried).not.toBe(mockAuth.userId);
    expect(res.status).toBe(201);
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
