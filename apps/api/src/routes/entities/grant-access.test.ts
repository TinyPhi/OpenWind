import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// Membership is decided by resolveTenantMembers (tenant_users, or the tenant's Zitadel org --
// covered by its own tests). This records what the handler asked it about, so the tests can
// prove the check targets the grant's target userId, not the actor's, and passes the orgId.
let tenantUserExists: boolean;
let expectedTargetUserId: string;
const mockResolveTenantMembers = vi.fn(
  (_tenantId: string, userIds: string[], _orgId?: string) =>
    Promise.resolve(
      new Set(
        tenantUserExists
          ? userIds.filter((id) => id === expectedTargetUserId)
          : [],
      ),
    ),
);
vi.mock("../../lib/ensure-user-refs.js", () => ({
  resolveTenantMembers: (
    ...args: Parameters<typeof mockResolveTenantMembers>
  ) => mockResolveTenantMembers(...args),
}));

function membershipQueriedFor(): string[] | undefined {
  return mockResolveTenantMembers.mock.calls.at(-1)?.[1];
}

vi.mock("drizzle-orm", () => {
  const eqFn = vi.fn(() => "sql");
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

const mockWriteAuditEntry = vi.fn();
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
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

const INST_ID = "00000000-0000-0000-0000-000000000002";

let instanceExists: boolean;
let instanceWorkflowId: string | null;
let instanceFields: Record<string, unknown>;

const mockTx = {
  select: () => mockTx,
  from: () => mockTx,
  where: () => mockTx,
  limit: () =>
    Promise.resolve(
      instanceExists
        ? [
            {
              id: INST_ID,
              workflowId: instanceWorkflowId,
              fields: instanceFields,
            },
          ]
        : [],
    ),
  update: () => ({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  }),
};

vi.mock("@platform/db", () => ({
  entityInstances: entityInstancesTable,
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
    instanceExists = true;
    instanceWorkflowId = null;
    instanceFields = {};
    tenantUserExists = true;
    expectedTargetUserId = "target-user";
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
    expect(membershipQueriedFor()).toEqual(["target-user"]);
  });

  it("checks membership against the tenant's Zitadel org too, so a member who never signed in can be granted", async () => {
    currentAuth = { ...currentAuth, orgId: "org-1" };

    const res = await makeApp().request(`/${INST_ID}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "target-user", level: "read_write" }),
    });

    expect(res.status).toBe(201);
    expect(mockResolveTenantMembers).toHaveBeenCalledWith(
      "t-aaa",
      ["target-user"],
      "org-1",
    );
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

    expect(membershipQueriedFor()).toEqual(["target-user"]);
    expect(membershipQueriedFor()).not.toContain(currentAuth.userId);
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

  describe("audit (#640)", () => {
    it("audits a first grant as access.granted with no before-state", async () => {
      const res = await makeApp().request(`/${INST_ID}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "target-user", level: "read_write" }),
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          tenantId: "t-aaa",
          actorId: "u-admin",
          actorType: "user",
          resourceType: "ticket",
          resourceId: INST_ID,
          action: "access.granted",
          beforeSnapshot: null,
          afterSnapshot: { level: "read_write", tag: "manual" },
          metadata: { targetUserId: "target-user", via: "direct" },
        }),
      );
    });

    it("audits overwriting an existing entry as access.updated with the prior level", async () => {
      instanceFields = {
        __accessUsers: {
          "target-user": { level: "read_only", tag: "mention" },
        },
      };

      const res = await makeApp().request(`/${INST_ID}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "target-user", level: "read_write" }),
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          action: "access.updated",
          beforeSnapshot: { level: "read_only", tag: "mention" },
          afterSnapshot: { level: "read_write", tag: "manual" },
        }),
      );
    });

    it("writes no audit entry when the grant leaves the entry unchanged", async () => {
      instanceFields = {
        __accessUsers: {
          "target-user": { level: "read_write", tag: "manual" },
        },
      };

      const res = await makeApp().request(`/${INST_ID}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "target-user",
          level: "read_write",
          tag: "manual",
        }),
      });

      expect(res.status).toBe(201);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it("writes no audit entry when the grant is refused", async () => {
      tenantUserExists = false;

      const res = await makeApp().request(`/${INST_ID}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "not-a-member", level: "read_write" }),
      });

      expect(res.status).toBe(404);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it("fails the request when the audit write fails, so a grant is never unaudited", async () => {
      mockWriteAuditEntry.mockRejectedValueOnce(new Error("audit down"));

      const res = await makeApp().request(`/${INST_ID}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "target-user", level: "read_write" }),
      });

      expect(res.status).toBe(500);
      expect(mockEmitAccessEvent).not.toHaveBeenCalled();
    });
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
