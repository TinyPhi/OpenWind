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

let currentAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-admin",
  roles: ["admin"],
  email: "admin@example.com",
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

vi.mock("@platform/workflow-engine", () => ({
  getWorkflow: vi.fn(),
  isWorkflowAdmin: vi.fn(() => false),
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
let instanceWorkflowId: string | null;
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
    return Promise.resolve(
      instanceExists ? [{ id: INST_ID, workflowId: instanceWorkflowId }] : [],
    );
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
const { isWorkflowAdmin, getWorkflow } =
  await import("@platform/workflow-engine");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/access", ...grantAccessHandler);
  return app;
}

describe("POST /entities/:id/access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-admin",
      roles: ["admin"],
      email: "admin@example.com",
    };
    currentFromTable = undefined;
    instanceExists = true;
    instanceWorkflowId = null;
    tenantUserExists = true;
    expectedTargetUserId = "target-user";
    lastTenantUsersUserIdQueried = undefined;
    vi.mocked(isWorkflowAdmin).mockReturnValue(false);
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
    expect(lastTenantUsersUserIdQueried).not.toBe(currentAuth.userId);
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

  describe("workflow-admin direct grant (issue #167)", () => {
    it("allows a workflow admin (role user, not tenant admin/agent) to grant access", async () => {
      currentAuth = {
        tenantId: "t-aaa",
        userId: "u-workflow-admin",
        roles: ["user"],
        email: "wa@example.com",
      };
      instanceWorkflowId = "wf-1";
      vi.mocked(isWorkflowAdmin).mockReturnValue(true);

      const res = await makeApp().request(`/${INST_ID}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "target-user", level: "read_write" }),
      });

      expect(res.status).toBe(201);
      expect(mockEmitAccessEvent).toHaveBeenCalledTimes(1);
      // Must check the ACTOR (caller), never the grant's target userId — a
      // mock that ignores its arguments would still pass this test if that
      // were swapped, which is why this asserts the exact call, not just
      // that isWorkflowAdmin was called. getWorkflow is unimplemented
      // (vi.fn()), so its resolved value is undefined — only the first
      // argument (the actor id) is meaningful to assert here.
      expect(vi.mocked(isWorkflowAdmin).mock.calls[0]?.[0]).toBe(
        "u-workflow-admin",
      );
      // getWorkflow must be looked up with the ACTOR's tenant/userId, not
      // the grant target's — same argument-mixup guard as above.
      expect(getWorkflow).toHaveBeenCalledWith(mockTx, "t-aaa", "wf-1", {
        userId: "u-workflow-admin",
        isGlobalAdmin: false,
      });
    });

    it("returns 404 for a plain user role that is not owner or workflow admin", async () => {
      currentAuth = {
        tenantId: "t-aaa",
        userId: "u-random",
        roles: ["user"],
        email: "random@example.com",
      };
      instanceWorkflowId = "wf-1";
      vi.mocked(isWorkflowAdmin).mockReturnValue(false);

      const res = await makeApp().request(`/${INST_ID}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "target-user", level: "read_write" }),
      });

      expect(res.status).toBe(404);
      expect(mockEmitAccessEvent).not.toHaveBeenCalled();
    });

    it("returns 404 for a plain user role when the record has no bound workflow", async () => {
      currentAuth = {
        tenantId: "t-aaa",
        userId: "u-random",
        roles: ["user"],
        email: "random@example.com",
      };
      instanceWorkflowId = null;

      const res = await makeApp().request(`/${INST_ID}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "target-user", level: "read_write" }),
      });

      expect(res.status).toBe(404);
      expect(mockEmitAccessEvent).not.toHaveBeenCalled();
      // No workflow bound → isWorkflowAdmin should never even be consulted.
      expect(isWorkflowAdmin).not.toHaveBeenCalled();
    });

    it("agent role is privileged and never consults isWorkflowAdmin", async () => {
      currentAuth = {
        tenantId: "t-aaa",
        userId: "u-agent",
        roles: ["agent"],
        email: "agent@example.com",
      };
      instanceWorkflowId = "wf-1";

      const res = await makeApp().request(`/${INST_ID}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "target-user", level: "read_write" }),
      });

      expect(res.status).toBe(201);
      expect(isWorkflowAdmin).not.toHaveBeenCalled();
    });
  });
});
