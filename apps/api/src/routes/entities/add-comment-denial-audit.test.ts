import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const mockHasCommentAccess = vi.fn();
const mockWriteAuditEntry = vi.fn();

let currentAuth: AuthContext;

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

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@platform/workflow-engine", () => ({
  getWorkflow: vi.fn(),
  isWorkflowAdmin: vi.fn(() => false),
}));

vi.mock("../../lib/zitadel-management.js", () => ({
  listOrgUsers: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/handle-entity-error.js", () => ({
  handleEntityError: (_c: unknown, err: unknown) => {
    throw err;
  },
}));

vi.mock("../../lib/entity-access.js", () => ({
  hasEntityCommentAccessFull: (...args: unknown[]) =>
    mockHasCommentAccess(...args),
}));

const INST_ID = "00000000-0000-0000-0000-000000000002";

// Resolves the instance row for the first lookup; after that, any further
// query (reached only when access is granted) rejects so tests can tell the
// handler went past the access check without modelling the whole write path.
const mockTx = {
  select: () => mockTx,
  from: () => mockTx,
  where: () => mockTx,
  limit: () =>
    Promise.resolve([
      {
        id: INST_ID,
        workflowId: "wf-1",
        currentState: "open",
        assignedTo: "someone-else",
        createdBy: "someone-else",
        fields: {},
      },
    ]),
};

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => "sql"),
  and: vi.fn(() => "sql"),
  inArray: vi.fn(() => "sql"),
  isNull: vi.fn(() => "sql"),
  sql: Object.assign(() => "sql", { join: vi.fn(() => "sql") }),
}));

vi.mock("@platform/db", () => ({
  workflowEvents: {},
  entityInstances: {},
  entityRelations: {},
  tenantUsers: {},
  files: {},
  outboxEvents: {},
  withTenantContext: (_t: unknown, fn: (tx: unknown) => unknown) => fn(mockTx),
}));

const { addCommentHandler } = await import("./add-comment.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/comments", ...addCommentHandler);
  return app;
}

function post() {
  return makeApp().request(`/${INST_ID}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
}

describe("POST /entities/:id/comments — denial audit (#640)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  it("returns 404 and writes one comment.access_denied for a non-privileged caller without comment access", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles: ["user"],
      email: "t@example.com",
    };
    mockHasCommentAccess.mockResolvedValue(false);

    const res = await post();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "NOT_FOUND",
      message: "Record not found",
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry.mock.calls[0][1]).toMatchObject({
      tenantId: "t-aaa",
      actorId: "u-bbb",
      actorType: "user",
      resourceType: "ticket",
      resourceId: INST_ID,
      action: "comment.access_denied",
    });
  });

  it("still returns the same 404 when the audit write fails", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles: ["user"],
      email: "t@example.com",
    };
    mockHasCommentAccess.mockResolvedValue(false);
    mockWriteAuditEntry.mockRejectedValue(new Error("audit down"));

    const res = await post();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "NOT_FOUND",
      message: "Record not found",
    });
  });

  it("never reaches the access check or denial audit for a privileged caller", async () => {
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-agent",
      roles: ["agent"],
      email: "a@example.com",
    };

    // The handler proceeds past the check into the write path, which this
    // minimal tx does not model; the outcome is irrelevant to the assertions.
    await post().catch(() => undefined);

    expect(mockHasCommentAccess).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });
});
