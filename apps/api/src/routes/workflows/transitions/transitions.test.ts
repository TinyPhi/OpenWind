import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

const mockAddTransition = vi.fn();
const mockUpdateTransition = vi.fn();
const mockDeleteTransition = vi.fn();

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: "t-aaa",
        userId: "u-bbb",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

let mockBeforeRow: {
  fromState?: string;
  toState?: string;
  allowedRoles: string[] | null;
} | null = {
  allowedRoles: [],
};
const mockPreRead = vi.fn();
const mockTx = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => {
          mockPreRead();
          return Promise.resolve(mockBeforeRow ? [mockBeforeRow] : []);
        },
      }),
    }),
  }),
};

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
  workflowTransitions: {
    id: "workflowTransitions.id",
    workflowId: "workflowTransitions.workflowId",
    tenantId: "workflowTransitions.tenantId",
    allowedRoles: "workflowTransitions.allowedRoles",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

const mockWriteAuditEntry = vi.fn();
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    addWorkflowTransition: (...args: unknown[]) => mockAddTransition(...args),
    updateWorkflowTransition: (...args: unknown[]) =>
      mockUpdateTransition(...args),
    deleteWorkflowTransition: (...args: unknown[]) =>
      mockDeleteTransition(...args),
  };
});

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createTransitionHandler } = await import("./create-transition.js");
const { updateTransitionHandler } = await import("./update-transition.js");
const { deleteTransitionHandler } = await import("./delete-transition.js");

const WF_ID = "00000000-0000-0000-0000-000000000010";
const TRANS_ID = "00000000-0000-0000-0000-000000000030";

const fakeTransition = {
  id: TRANS_ID,
  workflowId: WF_ID,
  fromState: "open",
  toState: "in_progress",
  label: "Start",
  allowedRoles: [],
  conditions: null,
  requiresComment: false,
  requiresFields: [],
};

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/transitions", ...createTransitionHandler);
  app.patch("/:id/transitions/:transitionId", ...updateTransitionHandler);
  app.delete("/:id/transitions/:transitionId", ...deleteTransitionHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBeforeRow = { allowedRoles: [] };
  mockWriteAuditEntry.mockResolvedValue(undefined);
});

describe("POST /workflows/:id/transitions", () => {
  it("returns 201 with created transition", async () => {
    mockAddTransition.mockResolvedValue(fakeTransition);

    const res = await makeApp().request(`/${WF_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromState: "open",
        toState: "in_progress",
        label: "Start",
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.fromState).toBe("open");
    expect(mockAddTransition).toHaveBeenCalledWith(
      mockTx,
      "t-aaa",
      WF_ID,
      { userId: "u-bbb", isGlobalAdmin: true },
      expect.objectContaining({ fromState: "open", toState: "in_progress" }),
    );
  });

  it("writes a transition_roles_updated entry with created:true metadata (#640)", async () => {
    mockAddTransition.mockResolvedValue({
      ...fakeTransition,
      allowedRoles: ["admin"],
    });

    const res = await makeApp().request(`/${WF_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromState: "open",
        toState: "in_progress",
        allowedRoles: ["admin"],
      }),
    });

    expect(res.status).toBe(201);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        tenantId: "t-aaa",
        actorId: "u-bbb",
        resourceType: "workflow",
        resourceId: WF_ID,
        action: "workflow.transition_roles_updated",
        beforeSnapshot: { [TRANS_ID]: null },
        afterSnapshot: { [TRANS_ID]: ["admin"] },
        metadata: {
          transitions: [
            {
              transitionId: TRANS_ID,
              fromState: "open",
              toState: "in_progress",
              created: true,
              deleted: false,
            },
          ],
        },
      }),
    );
  });

  it("fails the request when the audit write rejects", async () => {
    mockAddTransition.mockResolvedValue(fakeTransition);
    mockWriteAuditEntry.mockRejectedValue(new Error("audit down"));

    const res = await makeApp().request(`/${WF_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromState: "open", toState: "in_progress" }),
    });

    expect(res.status).toBe(500);
  });

  it("returns 400 when fromState is missing", async () => {
    const res = await makeApp().request(`/${WF_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toState: "in_progress" }),
    });
    expect(res.status).toBe(400);
    expect(mockAddTransition).not.toHaveBeenCalled();
  });

  it("accepts optional allowedRoles and conditions", async () => {
    mockAddTransition.mockResolvedValue(fakeTransition);

    await makeApp().request(`/${WF_ID}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromState: "open",
        toState: "closed",
        allowedRoles: ["admin"],
        conditions: { op: "eq", field: "priority", value: "high" },
      }),
    });

    expect(mockAddTransition).toHaveBeenCalledWith(
      mockTx,
      "t-aaa",
      WF_ID,
      { userId: "u-bbb", isGlobalAdmin: true },
      expect.objectContaining({ allowedRoles: ["admin"] }),
    );
  });
});

describe("PATCH /workflows/:id/transitions/:transitionId", () => {
  it("returns 200 with updated transition", async () => {
    mockUpdateTransition.mockResolvedValue({
      ...fakeTransition,
      allowedRoles: ["admin"],
    });

    const res = await makeApp().request(`/${WF_ID}/transitions/${TRANS_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedRoles: ["admin"] }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.allowedRoles).toEqual(["admin"]);
  });

  describe("role audit (#640)", () => {
    const patch = (body: unknown) =>
      makeApp().request(`/${WF_ID}/transitions/${TRANS_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    it("writes an entry with before/after when allowedRoles changes", async () => {
      mockBeforeRow = { allowedRoles: ["agent"] };
      mockUpdateTransition.mockResolvedValue({
        ...fakeTransition,
        allowedRoles: ["admin"],
      });

      const res = await patch({ allowedRoles: ["admin"] });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          resourceType: "workflow",
          resourceId: WF_ID,
          action: "workflow.transition_roles_updated",
          beforeSnapshot: { [TRANS_ID]: ["agent"] },
          afterSnapshot: { [TRANS_ID]: ["admin"] },
        }),
      );
    });

    it("writes no entry and does not pre-read when only the label changes", async () => {
      mockUpdateTransition.mockResolvedValue({
        ...fakeTransition,
        label: "New",
      });

      const res = await patch({ label: "New" });

      expect(res.status).toBe(200);
      expect(mockPreRead).not.toHaveBeenCalled();
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it("writes no entry when allowedRoles is resubmitted unchanged", async () => {
      mockBeforeRow = { allowedRoles: ["admin", "agent"] };
      mockUpdateTransition.mockResolvedValue({
        ...fakeTransition,
        allowedRoles: ["agent", "admin"],
      });

      const res = await patch({ allowedRoles: ["agent", "admin"] });

      expect(res.status).toBe(200);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    });

    it("fails the request when the audit write rejects", async () => {
      mockBeforeRow = { allowedRoles: [] };
      mockUpdateTransition.mockResolvedValue({
        ...fakeTransition,
        allowedRoles: ["admin"],
      });
      mockWriteAuditEntry.mockRejectedValue(new Error("audit down"));

      const res = await patch({ allowedRoles: ["admin"] });

      expect(res.status).toBe(500);
    });
  });

  it("returns 404 when transition not found", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockUpdateTransition.mockRejectedValue(
      new WorkflowError("WORKFLOW_TRANSITION_NOT_FOUND"),
    );

    const res = await makeApp().request(`/${WF_ID}/transitions/${TRANS_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /workflows/:id/transitions/:transitionId", () => {
  beforeEach(() => {
    mockWriteAuditEntry.mockClear();
    mockBeforeRow = {
      fromState: "open",
      toState: "in_progress",
      allowedRoles: ["manager"],
    };
  });

  it("returns 204 on success", async () => {
    mockDeleteTransition.mockResolvedValue(undefined);

    const res = await makeApp().request(`/${WF_ID}/transitions/${TRANS_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(mockDeleteTransition).toHaveBeenCalledWith(
      mockTx,
      "t-aaa",
      WF_ID,
      TRANS_ID,
      { userId: "u-bbb", isGlobalAdmin: true },
    );
  });

  it("returns 404 when transition not found", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockDeleteTransition.mockRejectedValue(
      new WorkflowError("WORKFLOW_TRANSITION_NOT_FOUND"),
    );

    const res = await makeApp().request(`/${WF_ID}/transitions/${TRANS_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("audits the removed role gate with its prior roles (#640)", async () => {
    mockDeleteTransition.mockResolvedValue(undefined);

    const res = await makeApp().request(`/${WF_ID}/transitions/${TRANS_ID}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        tenantId: "t-aaa",
        actorId: "u-bbb",
        resourceType: "workflow",
        resourceId: WF_ID,
        action: "workflow.transition_roles_updated",
        beforeSnapshot: { [TRANS_ID]: ["manager"] },
        afterSnapshot: { [TRANS_ID]: null },
      }),
    );
  });

  it("writes no audit entry when the delete is refused", async () => {
    const { WorkflowError } = await import("@platform/workflow-engine");
    mockDeleteTransition.mockRejectedValue(
      new WorkflowError("WORKFLOW_TRANSITION_NOT_FOUND"),
    );

    await makeApp().request(`/${WF_ID}/transitions/${TRANS_ID}`, {
      method: "DELETE",
    });

    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("fails the request when the audit write fails, so the delete rolls back", async () => {
    mockDeleteTransition.mockResolvedValue(undefined);
    mockWriteAuditEntry.mockRejectedValueOnce(new Error("audit down"));

    const res = await makeApp().request(`/${WF_ID}/transitions/${TRANS_ID}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(500);
  });
});
