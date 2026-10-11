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

const { updateAccessHandler } = await import("./update-access.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.patch("/:id/access/:userId", ...updateAccessHandler);
  return app;
}

function update(level: string, userId = "target-user") {
  return makeApp().request(`/${INST_ID}/access/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level }),
  });
}

describe("PATCH /entities/:id/access/:userId audit (#640)", () => {
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
          "target-user": { level: "read_only", tag: "mention" },
        },
      },
    };
  });

  it("audits a level change as access.updated with before/after levels and the tag preserved", async () => {
    const res = await update("read_write");

    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(mockTx, {
      tenantId: "t-aaa",
      actorId: "u-admin",
      actorType: "user",
      resourceType: "ticket",
      resourceId: INST_ID,
      action: "access.updated",
      beforeSnapshot: { level: "read_only", tag: "mention" },
      afterSnapshot: { level: "read_write", tag: "mention" },
      metadata: { targetUserId: "target-user", via: "direct" },
    });
    expect(mockEmitAccessEvent).toHaveBeenCalledTimes(1);
  });

  it("defaults the tag to manual for a legacy entry without one", async () => {
    instanceRow.fields = {
      __accessUsers: { "target-user": { level: "read_only" } },
    };

    await update("read_comment");

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        beforeSnapshot: { level: "read_only", tag: "manual" },
        afterSnapshot: { level: "read_comment", tag: "manual" },
      }),
    );
  });

  it("flags metadata.unassigned when the assignee is downgraded from read_write", async () => {
    instanceRow.assignedTo = "target-user";
    instanceRow.fields = {
      __accessUsers: { "target-user": { level: "read_write", tag: "manual" } },
    };

    const res = await update("read_only");

    expect(res.status).toBe(200);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        action: "access.updated",
        beforeSnapshot: { level: "read_write", tag: "manual" },
        afterSnapshot: { level: "read_only", tag: "manual" },
        metadata: {
          targetUserId: "target-user",
          via: "direct",
          unassigned: true,
        },
      }),
    );
  });

  it("does not flag unassigned when the assignee keeps read_write", async () => {
    instanceRow.assignedTo = "target-user";

    await update("read_write");

    const entry = mockWriteAuditEntry.mock.calls[0]?.[1] as {
      metadata: Record<string, unknown>;
    };
    expect(entry.metadata).not.toHaveProperty("unassigned");
  });

  it("returns 404 ACCESS_ENTRY_NOT_FOUND and writes no audit entry when the user has no grant", async () => {
    const res = await update("read_write", "never-granted");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "ACCESS_ENTRY_NOT_FOUND" });
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(mockEmitAccessEvent).not.toHaveBeenCalled();
  });

  it("returns 404 and writes no audit entry for a non-owner non-admin", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-random",
      roles: ["user"],
      email: "random@example.com",
    };

    const res = await update("read_write");

    expect(res.status).toBe(404);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(mockEmitAccessEvent).not.toHaveBeenCalled();
  });

  it("returns 404 and writes no audit entry when the record does not exist", async () => {
    instanceExists = false;

    const res = await update("read_write");

    expect(res.status).toBe(404);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("fails the request and emits no event when the audit write fails", async () => {
    mockWriteAuditEntry.mockRejectedValueOnce(new Error("audit down"));

    const res = await update("read_write");

    expect(res.status).toBe(500);
    expect(mockEmitAccessEvent).not.toHaveBeenCalled();
  });
});
