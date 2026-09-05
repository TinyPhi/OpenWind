import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

let mockAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-no-access",
  roles: ["user"],
  email: "test@example.com",
  orgId: "org-ccc",
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

const mockRemoveEntityInstanceTag = vi.fn();
const mockGetEntity = vi.fn().mockResolvedValue({
  id: "instance-1",
  workflowId: null,
  currentState: "open",
});

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    removeEntityInstanceTag: (...args: unknown[]) =>
      mockRemoveEntityInstanceTag(...args),
    getEntity: (...args: unknown[]) => mockGetEntity(...args),
  };
});

const mockTx = {
  select: () => mockTx,
  from: () => mockTx,
  where: () => mockTx,
  limit: () => Promise.resolve([{ workflowId: null }]),
  insert: () => ({ values: () => Promise.resolve(undefined) }),
};

vi.mock("@platform/db", () => ({
  entityInstances: {
    workflowId: "workflow_id",
    tenantId: "tenant_id",
    id: "id",
  },
  workflowEvents: {},
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

vi.mock("@platform/workflow-engine", () => ({
  getWorkflow: vi.fn(),
  isWorkflowAdmin: vi.fn().mockReturnValue(false),
}));

const mockAssertRecordWorkflowAccess = vi.fn();
vi.mock("../../lib/assert-record-workflow-access.js", () => ({
  assertRecordWorkflowAccess: (...args: unknown[]) =>
    mockAssertRecordWorkflowAccess(...args),
}));

const { removeTagHandler } = await import("./remove-tag.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.delete("/entities/:id/tags/:tagId", ...removeTagHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth = {
    tenantId: "t-aaa",
    userId: "u-no-access",
    roles: ["user"],
    email: "test@example.com",
    orgId: "org-ccc",
  };
  mockGetEntity.mockResolvedValue({
    id: "instance-1",
    workflowId: null,
    currentState: "open",
  });
});

describe("removeTagHandler — access gate (docs/specs/ticket-severity-and-tags.md R4/R5)", () => {
  it("returns 404 for a non-privileged caller with no relationship to the ticket, without ever calling removeEntityInstanceTag", async () => {
    // Simulates assertRecordWorkflowAccess's real behavior for a caller who
    // is not creator/assignee/workflow-admin: it throws ENTITY_NOT_FOUND.
    const { EntityError } = await import("@platform/entity-engine");
    mockAssertRecordWorkflowAccess.mockRejectedValue(
      new EntityError("ENTITY_NOT_FOUND", { instanceId: "instance-1" }),
    );

    const app = makeApp();
    const res = await app.request("/entities/instance-1/tags/tag-1", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    expect(mockAssertRecordWorkflowAccess).toHaveBeenCalledOnce();
    // The fix under test: removeEntityInstanceTag must never be reached once
    // the access gate rejects — the pre-fix version skipped this gate
    // entirely and would have called through regardless.
    expect(mockRemoveEntityInstanceTag).not.toHaveBeenCalled();
  });

  it("proceeds to removeEntityInstanceTag for a caller who passes the access gate", async () => {
    mockAssertRecordWorkflowAccess.mockResolvedValue(undefined);
    mockRemoveEntityInstanceTag.mockResolvedValue({
      id: "tag-1",
      tenantId: "t-aaa",
      entityInstanceId: "instance-1",
      tagText: "railways",
      createdBy: "u-no-access",
      createdAt: new Date(),
    });

    const app = makeApp();
    const res = await app.request("/entities/instance-1/tags/tag-1", {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    expect(mockAssertRecordWorkflowAccess).toHaveBeenCalledOnce();
    expect(mockRemoveEntityInstanceTag).toHaveBeenCalledOnce();
  });

  it("skips the access gate entirely for a privileged (admin/agent) caller", async () => {
    mockAuth = { ...mockAuth, roles: ["admin"] };
    mockRemoveEntityInstanceTag.mockResolvedValue({
      id: "tag-1",
      tenantId: "t-aaa",
      entityInstanceId: "instance-1",
      tagText: "railways",
      createdBy: "someone-else",
      createdAt: new Date(),
    });

    const app = makeApp();
    const res = await app.request("/entities/instance-1/tags/tag-1", {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    expect(mockAssertRecordWorkflowAccess).not.toHaveBeenCalled();
    expect(mockRemoveEntityInstanceTag).toHaveBeenCalledWith(
      expect.anything(),
      "t-aaa",
      "instance-1",
      "tag-1",
      "u-no-access",
      true,
    );
  });
});
