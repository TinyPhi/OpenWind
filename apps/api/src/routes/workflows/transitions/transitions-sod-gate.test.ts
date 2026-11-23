import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

const TR_ID = "00000000-0000-0000-0000-000000000030";
const mockAdd = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
let mockAuth = { userId: "u-agent", roles: ["agent"] };
let mockBefore: { allowedRoles: string[]; conditions: unknown } = {
  allowedRoles: [],
  conditions: null,
};
// The other transitions of the same workflow, next to the one being edited (mockBefore).
let mockSiblings: Array<{
  id: string;
  allowedRoles: string[];
  conditions: unknown;
}> = [];
let mockOwned = true;

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", { tenantId: "t-aaa", email: "t@e.c", ...mockAuth });
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

const workflowRows = () => [{ id: TR_ID, ...mockBefore }, ...mockSiblings];
const mockTx = {
  select: () => ({
    from: () => ({
      where: () =>
        Object.assign(Promise.resolve(workflowRows()), {
          limit: () => Promise.resolve([mockBefore]),
        }),
    }),
  }),
};
vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) => fn(mockTx),
  workflowTransitions: {},
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));
vi.mock("@platform/audit", () => ({
  writeAuditEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    assertWorkflowOwned: async () => {
      if (!mockOwned) {
        throw new real.WorkflowError("WORKFLOW_NOT_FOUND", {
          workflowId: "wf",
        });
      }
    },
    addWorkflowTransition: (...a: unknown[]) => mockAdd(...a),
    updateWorkflowTransition: (...a: unknown[]) => mockUpdate(...a),
    deleteWorkflowTransition: (...a: unknown[]) => mockDelete(...a),
  };
});
vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createTransitionHandler } = await import("./create-transition.js");
const { updateTransitionHandler } = await import("./update-transition.js");
const { deleteTransitionHandler } = await import("./delete-transition.js");

const WF = "00000000-0000-0000-0000-000000000010";
const TR = "00000000-0000-0000-0000-000000000030";
const RULE = { op: "actor_not_creator" };
const row = {
  id: TR,
  workflowId: WF,
  fromState: "a",
  toState: "b",
  allowedRoles: [],
  conditions: null,
};

function app() {
  const a = new Hono<{ Variables: { auth: AuthContext } }>();
  a.post("/:id/transitions", ...createTransitionHandler);
  a.patch("/:id/transitions/:transitionId", ...updateTransitionHandler);
  a.delete("/:id/transitions/:transitionId", ...deleteTransitionHandler);
  return a;
}
const send = (method: string, path: string, body?: unknown) =>
  app().request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth = { userId: "u-agent", roles: ["agent"] };
  mockBefore = { allowedRoles: [], conditions: null };
  mockSiblings = [];
  mockOwned = true;
  mockAdd.mockResolvedValue({ ...row, conditions: RULE });
  mockUpdate.mockResolvedValue(row);
  mockDelete.mockResolvedValue(undefined);
});

describe("actor rule changes are limited to a person admin (#1008)", () => {
  it("refuses a non-admin creating a transition with a rule", async () => {
    const res = await send("POST", `/${WF}/transitions`, {
      fromState: "a",
      toState: "b",
      conditions: RULE,
    });
    expect(res.status).toBe(403);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("refuses a non-admin clearing a rule", async () => {
    mockBefore = { allowedRoles: [], conditions: RULE };
    const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
      conditions: null,
    });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses a non-admin deleting a transition that carries a rule", async () => {
    mockBefore = { allowedRoles: [], conditions: RULE };
    const res = await send("DELETE", `/${WF}/transitions/${TR}`);
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("refuses an API key that carries the admin role", async () => {
    mockAuth = { userId: "apikey:k1", roles: ["admin"] };
    mockBefore = { allowedRoles: [], conditions: RULE };
    const res = await send("DELETE", `/${WF}/transitions/${TR}`);
    expect(res.status).toBe(403);
  });

  it("lets a person admin clear a rule", async () => {
    mockAuth = { userId: "u-admin", roles: ["admin"] };
    mockBefore = { allowedRoles: [], conditions: RULE };
    const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
      conditions: null,
    });
    expect(res.status).toBe(200);
  });

  it("still lets a non-admin edit a transition that has no rule", async () => {
    const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
      label: "Start",
    });
    expect(res.status).toBe(200);
    const del = await send("DELETE", `/${WF}/transitions/${TR}`);
    expect(del.status).toBe(204);
  });

  describe("a workflow that carries an actor rule is admin-only to rewire (#1132)", () => {
    const RULED = { id: "r1", allowedRoles: ["agent"], conditions: RULE };
    const UNRULED = { id: "s1", allowedRoles: ["admin"], conditions: null };
    const createBody = (fromState: string, toState: string) => ({
      fromState,
      toState,
      allowedRoles: ["agent"],
      conditions: null,
    });

    it("refuses a non-admin adding an unruled transition on the ruled edge", async () => {
      mockSiblings = [RULED];
      const res = await send(
        "POST",
        `/${WF}/transitions`,
        createBody("a", "b"),
      );
      expect(res.status).toBe(403);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("refuses the two-hop detour: each leg is on an edge that carries no rule itself", async () => {
      mockSiblings = [{ ...RULED }];
      const first = await send(
        "POST",
        `/${WF}/transitions`,
        createBody("pending_approval", "fast_track"),
      );
      const second = await send(
        "POST",
        `/${WF}/transitions`,
        createBody("fast_track", "approved"),
      );
      expect(first.status).toBe(403);
      expect(second.status).toBe(403);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("refuses a skip edge from the ruled step to a later step", async () => {
      mockSiblings = [{ ...RULED }];
      const res = await send(
        "POST",
        `/${WF}/transitions`,
        createBody("pending_approval", "paid"),
      );
      expect(res.status).toBe(403);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("lets a non-admin add a transition to a workflow with no actor rule", async () => {
      mockSiblings = [UNRULED];
      mockAdd.mockResolvedValue({ ...row, conditions: null });
      const res = await send(
        "POST",
        `/${WF}/transitions`,
        createBody("a", "b"),
      );
      expect(res.status).toBe(201);
      expect(mockAdd).toHaveBeenCalled();
    });

    it("lets a person admin add an alternate transition on a ruled workflow", async () => {
      mockAuth = { userId: "u-admin", roles: ["admin"] };
      mockSiblings = [RULED];
      mockAdd.mockResolvedValue({ ...row, conditions: null });
      const res = await send(
        "POST",
        `/${WF}/transitions`,
        createBody("a", "b"),
      );
      expect(res.status).toBe(201);
    });

    it("refuses an API key holding admin adding a transition to a ruled workflow", async () => {
      mockAuth = { userId: "apikey:k1", roles: ["admin"] };
      mockSiblings = [RULED];
      const res = await send(
        "POST",
        `/${WF}/transitions`,
        createBody("a", "b"),
      );
      expect(res.status).toBe(403);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("answers 404, not 403, to a caller who does not administer the workflow", async () => {
      mockOwned = false;
      mockSiblings = [RULED];
      const create = await send(
        "POST",
        `/${WF}/transitions`,
        createBody("a", "b"),
      );
      mockBefore = { allowedRoles: ["admin"], conditions: null };
      const update = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["agent"],
      });
      expect(create.status).toBe(404);
      expect(update.status).toBe(404);
      expect(mockAdd).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("refuses a non-admin patching allowedRoles on the ruled transition", async () => {
      mockBefore = { allowedRoles: ["admin"], conditions: RULE };
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["agent"],
      });
      expect(res.status).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("refuses a non-admin widening allowedRoles on an unruled sibling of a ruled edge", async () => {
      mockBefore = { allowedRoles: ["admin"], conditions: null };
      mockSiblings = [RULED];
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["agent"],
      });
      expect(res.status).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("refuses a non-admin changing the conditions of an unruled transition on a ruled workflow", async () => {
      mockBefore = { allowedRoles: ["admin"], conditions: null };
      mockSiblings = [RULED];
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        conditions: { op: "not_empty", field: "x" },
      });
      expect(res.status).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("refuses an API key holding admin patching allowedRoles on a ruled workflow", async () => {
      mockAuth = { userId: "apikey:k1", roles: ["admin"] };
      mockBefore = { allowedRoles: ["admin"], conditions: RULE };
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["agent"],
      });
      expect(res.status).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("lets a person admin patch allowedRoles on a ruled workflow", async () => {
      mockAuth = { userId: "u-admin", roles: ["admin"] };
      mockBefore = { allowedRoles: ["admin"], conditions: RULE };
      mockUpdate.mockResolvedValue({ ...row, allowedRoles: ["agent"] });
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["agent"],
      });
      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("lets a non-admin patch allowedRoles on a workflow with no actor rule", async () => {
      mockBefore = { allowedRoles: ["admin"], conditions: null };
      mockSiblings = [UNRULED];
      mockUpdate.mockResolvedValue({ ...row, allowedRoles: ["agent"] });
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["agent"],
      });
      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("lets a non-admin resubmit the same allowedRoles, in any order, on a ruled workflow", async () => {
      mockBefore = { allowedRoles: ["admin", "agent"], conditions: RULE };
      mockUpdate.mockResolvedValue({
        ...row,
        allowedRoles: ["agent", "admin"],
      });
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["agent", "admin"],
      });
      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("lets a non-admin change only the label on a ruled workflow", async () => {
      mockBefore = { allowedRoles: ["admin"], conditions: null };
      mockSiblings = [RULED];
      mockUpdate.mockResolvedValue({ ...row, label: "Start" });
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        label: "Start",
      });
      expect(res.status).toBe(200);
    });
  });
});
