import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

const mockAdd = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
let mockAuth = { userId: "u-agent", roles: ["agent"] };
let mockBefore: { allowedRoles: string[]; conditions: unknown } = {
  allowedRoles: [],
  conditions: null,
};
let mockExistingOnEdge: Array<{ id: string; conditions: unknown }> = [];

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

const mockTx = {
  select: () => ({
    from: () => ({
      where: () =>
        Object.assign(Promise.resolve(mockExistingOnEdge), {
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
  mockExistingOnEdge = [];
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

  describe("duplicate edge and allowedRoles protection (#1132)", () => {
    it("refuses a non-admin creating an unruled transition on an edge where a ruled transition already exists", async () => {
      mockExistingOnEdge = [{ id: TR, conditions: RULE }];
      const res = await send("POST", `/${WF}/transitions`, {
        fromState: "a",
        toState: "b",
        allowedRoles: ["agent"],
        conditions: null,
      });
      expect(res.status).toBe(403);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("lets a person admin create an alternate transition on an edge where a ruled transition exists", async () => {
      mockAuth = { userId: "u-admin", roles: ["admin"] };
      mockExistingOnEdge = [{ id: TR, conditions: RULE }];
      mockAdd.mockResolvedValue({
        ...row,
        conditions: null,
        allowedRoles: ["agent"],
      });
      const res = await send("POST", `/${WF}/transitions`, {
        fromState: "a",
        toState: "b",
        allowedRoles: ["agent"],
        conditions: null,
      });
      expect(res.status).toBe(201);
      expect(mockAdd).toHaveBeenCalled();
    });

    it("refuses a non-admin patching allowedRoles on a transition that carries an actor rule", async () => {
      mockBefore = { allowedRoles: ["admin"], conditions: RULE };
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["agent"],
      });
      expect(res.status).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("refuses an API key holding admin patching allowedRoles on a ruled transition", async () => {
      mockAuth = { userId: "apikey:k1", roles: ["admin"] };
      mockBefore = { allowedRoles: ["admin"], conditions: RULE };
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["agent"],
      });
      expect(res.status).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("lets a person admin patch allowedRoles on a ruled transition", async () => {
      mockAuth = { userId: "u-admin", roles: ["admin"] };
      mockBefore = { allowedRoles: ["admin"], conditions: RULE };
      mockUpdate.mockResolvedValue({ ...row, allowedRoles: ["agent"] });
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["agent"],
      });
      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("lets a non-admin patch allowedRoles on a transition with no rule", async () => {
      mockBefore = { allowedRoles: ["admin"], conditions: null };
      mockUpdate.mockResolvedValue({ ...row, allowedRoles: ["agent"] });
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["agent"],
      });
      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("lets a non-admin resubmit unchanged allowedRoles on a ruled transition", async () => {
      mockBefore = { allowedRoles: ["admin"], conditions: RULE };
      mockUpdate.mockResolvedValue({ ...row, allowedRoles: ["admin"] });
      const res = await send("PATCH", `/${WF}/transitions/${TR}`, {
        allowedRoles: ["admin"],
      });
      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });
});
