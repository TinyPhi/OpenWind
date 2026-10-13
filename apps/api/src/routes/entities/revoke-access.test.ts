import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

vi.mock("drizzle-orm", () => {
  const sqlFn = Object.assign(
    (_strings: TemplateStringsArray, ..._vals: unknown[]) => "sql",
    { join: vi.fn(() => "sql") },
  );
  return { eq: vi.fn(() => "sql"), and: vi.fn(() => "sql"), sql: sqlFn };
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

const mockCancelAlerts = vi.fn();
vi.mock("../../lib/cascade-cancel-alerts.js", () => ({
  cancelUsersPendingAlertsForInstance: (...args: unknown[]) =>
    mockCancelAlerts(...args),
}));

vi.mock("../../lib/handle-entity-error.js", () => ({
  handleEntityError: (_c: unknown, err: unknown) => {
    throw err;
  },
}));

const INST_ID = "00000000-0000-0000-0000-000000000002";

let instanceExists: boolean;
let instanceRow: {
  id: string;
  assignedTo: string | null;
  createdBy: string | null;
  workflowId: string | null;
  fields: Record<string, unknown>;
};

const mockTx = {
  select: () => mockTx,
  from: () => mockTx,
  where: () => mockTx,
  limit: () => Promise.resolve(instanceExists ? [instanceRow] : []),
  update: () => ({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  }),
};

vi.mock("@platform/db", () => ({
  entityInstances: {
    id: "entity_instances.id",
    tenantId: "entity_instances.tenant_id",
  },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

const { revokeAccessHandler } = await import("./revoke-access.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.delete("/:id/access/:userId", ...revokeAccessHandler);
  return app;
}

function revoke(userId = "target-user") {
  return makeApp().request(`/${INST_ID}/access/${userId}`, {
    method: "DELETE",
  });
}

describe("DELETE /entities/:id/access/:userId audit (#640)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-admin",
      roles: ["admin"],
      email: "admin@example.com",
    };
    instanceExists = true;
    instanceRow = {
      id: INST_ID,
      assignedTo: null,
      createdBy: "u-creator",
      workflowId: null,
      fields: {
        __accessUsers: {
          "target-user": { level: "read_comment", tag: "mention" },
        },
      },
    };
  });

  it("audits a revoke as access.revoked with the prior entry and no after-state", async () => {
    const res = await revoke();

    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(mockTx, {
      tenantId: "t-aaa",
      actorId: "u-admin",
      actorType: "user",
      resourceType: "ticket",
      resourceId: INST_ID,
      action: "access.revoked",
      beforeSnapshot: { level: "read_comment", tag: "mention" },
      afterSnapshot: null,
      metadata: { targetUserId: "target-user", via: "direct" },
    });
    expect(mockEmitAccessEvent).toHaveBeenCalledTimes(1);
  });

  it("flags metadata.unassigned when the revoked user was the assignee", async () => {
    instanceRow.assignedTo = "target-user";

    const res = await revoke();

    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        action: "access.revoked",
        metadata: {
          targetUserId: "target-user",
          via: "direct",
          unassigned: true,
        },
      }),
    );
  });

  it("does not flag unassigned when a different user is the assignee", async () => {
    instanceRow.assignedTo = "someone-else";

    await revoke();

    const entry = mockWriteAuditEntry.mock.calls[0]?.[1] as {
      metadata: Record<string, unknown>;
    };
    expect(entry.metadata).not.toHaveProperty("unassigned");
  });

  it("lets a record creator without admin or agent role revoke and audits it", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-creator",
      roles: ["user"],
      email: "creator@example.com",
    };

    const res = await revoke();

    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ actorId: "u-creator" }),
    );
  });

  it("returns 404 and writes no audit entry for a non-owner non-admin", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-random",
      roles: ["user"],
      email: "random@example.com",
    };

    const res = await revoke();

    expect(res.status).toBe(404);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(mockEmitAccessEvent).not.toHaveBeenCalled();
  });

  it("returns 404 and writes no audit entry when the record does not exist", async () => {
    instanceExists = false;

    const res = await revoke();

    expect(res.status).toBe(404);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(mockEmitAccessEvent).not.toHaveBeenCalled();
  });

  it("fails the request and emits no event when the audit write fails", async () => {
    mockWriteAuditEntry.mockRejectedValueOnce(new Error("audit down"));

    const res = await revoke();

    expect(res.status).toBe(500);
    expect(mockEmitAccessEvent).not.toHaveBeenCalled();
    expect(mockCancelAlerts).not.toHaveBeenCalled();
  });

  it("does not audit revoking a user who has no entry and is not the assignee", async () => {
    const res = await revoke("never-granted");

    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });
});
