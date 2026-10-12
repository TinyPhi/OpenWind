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

let currentAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-owner",
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
const accessRequestsTable = {
  id: "access_requests.id",
  tenantId: "access_requests.tenant_id",
  instanceId: "access_requests.instance_id",
  status: "access_requests.status",
};

const INST_ID = "00000000-0000-0000-0000-000000000002";
const REQ_ID = "00000000-0000-0000-0000-0000000000aa";
const REQUESTER_ID = "00000000-0000-0000-0000-0000000000bb";

let instanceRow: {
  id: string;
  createdBy: string | null;
  assignedTo: string | null;
  workflowId: string | null;
  fields: Record<string, unknown>;
} | null;

let accessRequestRow: {
  id: string;
  status: string;
  requesterId: string;
  requestedLevel: string;
} | null;

// Controls what the UPDATE ... WHERE status='pending' RETURNING resolves to —
// simulating whether that WHERE clause actually matched a row at write time,
// independent of what the earlier plain SELECT saw.
let updateMatchesPending: boolean;

let currentFromTable: unknown;

const mockTx = {
  select: () => mockTx,
  from: (table: unknown) => {
    currentFromTable = table;
    return mockTx;
  },
  where: () => mockTx,
  limit: () => {
    if (currentFromTable === accessRequestsTable) {
      return Promise.resolve(accessRequestRow ? [accessRequestRow] : []);
    }
    return Promise.resolve(instanceRow ? [instanceRow] : []);
  },
  update: (table: unknown) => ({
    set: () => ({
      where: () => ({
        returning: () => {
          if (table === accessRequestsTable) {
            return Promise.resolve(
              updateMatchesPending ? [{ id: REQ_ID }] : [],
            );
          }
          return Promise.resolve(undefined);
        },
      }),
    }),
  }),
  // Only the access_request.updated outbox write (T4,
  // docs/specs/ticket-live-updates.md) goes through insert() in this route.
  insert: () => ({
    values: (arg: unknown) => {
      outboxInserts.push(arg as { eventType: string; payload: unknown });
      return Promise.resolve(undefined);
    },
  }),
};

const outboxInserts: Array<{ eventType: string; payload: unknown }> = [];

const outboxEventsTable = { id: "outbox_events.id" };

vi.mock("@platform/db", () => ({
  entityInstances: entityInstancesTable,
  accessRequests: accessRequestsTable,
  outboxEvents: outboxEventsTable,
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

const { resolveAccessRequestHandler } =
  await import("./resolve-access-request.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.patch("/:id/access-requests/:reqId", ...resolveAccessRequestHandler);
  return app;
}

describe("PATCH /entities/:id/access-requests/:reqId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboxInserts.length = 0;
    currentFromTable = undefined;
    updateMatchesPending = true;
    instanceRow = {
      id: INST_ID,
      createdBy: "u-owner",
      assignedTo: null,
      workflowId: null,
      fields: {},
    };
    accessRequestRow = {
      id: REQ_ID,
      status: "pending",
      requesterId: REQUESTER_ID,
      requestedLevel: "read_comment",
    };
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-owner",
      roles: ["user"],
      email: "test@example.com",
    };
  });

  it("approves a pending request and emits an access_grant event", async () => {
    const res = await makeApp().request(
      `/${INST_ID}/access-requests/${REQ_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      },
    );

    expect(res.status).toBe(200);
    expect(mockEmitAccessEvent).toHaveBeenCalledWith(
      "t-aaa",
      INST_ID,
      "u-owner",
      expect.objectContaining({ type: "access_grant" }),
    );
    const updatedEvent = outboxInserts.find(
      (o) => o.eventType === "access_request.updated",
    );
    expect(
      (updatedEvent?.payload as { status: string; requestId: string }).status,
    ).toBe("approved");
    expect(
      (updatedEvent?.payload as { status: string; requestId: string })
        .requestId,
    ).toBe(REQ_ID);
  });

  it("rejects a pending request and emits an access_reject event (previously emitted nothing)", async () => {
    const res = await makeApp().request(
      `/${INST_ID}/access-requests/${REQ_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject" }),
      },
    );

    expect(res.status).toBe(200);
    expect(mockEmitAccessEvent).toHaveBeenCalledWith(
      "t-aaa",
      INST_ID,
      "u-owner",
      expect.objectContaining({ type: "access_reject" }),
    );
    const updatedEvent = outboxInserts.find(
      (o) => o.eventType === "access_request.updated",
    );
    expect((updatedEvent?.payload as { status: string }).status).toBe(
      "rejected",
    );
  });

  it("returns 422 and emits nothing when a concurrent resolve wins the race (UPDATE WHERE status=pending matches no row)", async () => {
    // The plain SELECT above still sees status='pending' (this request hasn't
    // been re-fetched), but by the time the UPDATE's own WHERE re-checks
    // status='pending' at write time, another request already resolved it.
    updateMatchesPending = false;

    const res = await makeApp().request(
      `/${INST_ID}/access-requests/${REQ_ID}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      },
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("ACCESS_REQUEST_ALREADY_RESOLVED");
    expect(mockEmitAccessEvent).not.toHaveBeenCalled();
  });

  describe("audit (#640)", () => {
    async function resolve(body: Record<string, unknown>): Promise<Response> {
      return makeApp().request(`/${INST_ID}/access-requests/${REQ_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("audits an approval as one access.granted entry attributed to the access request", async () => {
      const res = await resolve({ action: "approve" });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          tenantId: "t-aaa",
          actorId: "u-owner",
          actorType: "user",
          resourceType: "ticket",
          resourceId: INST_ID,
          action: "access.granted",
          beforeSnapshot: null,
          afterSnapshot: { level: "read_comment", tag: "manual" },
          metadata: {
            targetUserId: REQUESTER_ID,
            via: "access_request",
            requestId: REQ_ID,
          },
        }),
      );
    });

    it("audits the overridden level when the approver grants a different level than requested", async () => {
      const res = await resolve({ action: "approve", level: "read_write" });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          action: "access.granted",
          afterSnapshot: { level: "read_write", tag: "manual" },
        }),
      );
    });

    it("audits approval as access.updated with the before-state when the requester already has an entry", async () => {
      instanceRow = {
        id: INST_ID,
        createdBy: "u-owner",
        assignedTo: null,
        workflowId: null,
        fields: {
          __accessUsers: {
            [REQUESTER_ID]: { level: "read_only", tag: "mention" },
          },
        },
      };

      const res = await resolve({ action: "approve" });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          action: "access.updated",
          beforeSnapshot: { level: "read_only", tag: "mention" },
          afterSnapshot: { level: "read_comment", tag: "manual" },
        }),
      );
    });

    it("writes no audit entry when a request is rejected, since rejection changes no permission", async () => {
      const res = await resolve({ action: "reject" });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it("writes no audit entry when the request was already resolved", async () => {
      accessRequestRow = {
        id: REQ_ID,
        status: "approved",
        requesterId: REQUESTER_ID,
        requestedLevel: "read_comment",
      };

      const res = await resolve({ action: "approve" });

      expect(res.status).toBe(422);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it("writes no audit entry when a concurrent resolve wins the race", async () => {
      updateMatchesPending = false;

      const res = await resolve({ action: "approve" });

      expect(res.status).toBe(422);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it("fails the request and emits no access_grant event when the audit write fails", async () => {
      mockWriteAuditEntry.mockRejectedValueOnce(new Error("audit down"));

      const res = await resolve({ action: "approve" });

      expect(res.status).toBe(500);
      expect(mockEmitAccessEvent).not.toHaveBeenCalled();
      expect(outboxInserts).toHaveLength(0);
    });
  });
});
