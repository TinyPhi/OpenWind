import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const mockAuth = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["agent"] as string[],
  email: "test@example.com",
};

const mockWriteAuditEntry = vi.fn();

let deleteReturnsRow = true;

const mockDeletedRow = {
  ticketInstanceId: "00000000-0000-0000-0000-000000000002",
  labelId: "00000000-0000-0000-0000-000000000050",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth as AuthContext);
      await next();
    },
  requireRole:
    (...allowedRoles: string[]) =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      const auth = c.get("auth");
      if (!auth?.roles.some((r) => allowedRoles.includes(r))) {
        return c.json({ error: "FORBIDDEN" }, 403);
      }
      await next();
    },
}));

vi.mock("@platform/db", () => ({
  db: {},
  ticketLabels: {
    ticketInstanceId: "ticketInstanceId",
    labelId: "labelId",
    tenantId: "tenantId",
  },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      delete: () => tx,
      where: () => tx,
      returning: () =>
        Promise.resolve(deleteReturnsRow ? [mockDeletedRow] : []),
    };
    return fn(tx);
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (...args: unknown[]) => ({ op: "eq", args }),
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => {
    mockWriteAuditEntry(...args);
    return Promise.resolve();
  },
}));

const { deleteLabelHandler } = await import("./delete-label.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.delete("/:id/labels/:labelId", ...deleteLabelHandler);
  return app;
}

const INST_ID = "00000000-0000-0000-0000-000000000002";
const LABEL_ID = "00000000-0000-0000-0000-000000000050";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.roles = ["agent"];
  deleteReturnsRow = true;
});

describe("DELETE /entities/:id/labels/:labelId", () => {
  it("returns 204 on successful removal", async () => {
    const res = await makeApp().request(`/${INST_ID}/labels/${LABEL_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "label.removed" }),
    );
  });

  it("returns 404 when the label is not assigned to this ticket", async () => {
    deleteReturnsRow = false;
    const res = await makeApp().request(`/${INST_ID}/labels/${LABEL_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for a role outside admin/agent", async () => {
    mockAuth.roles = ["user"];
    const res = await makeApp().request(`/${INST_ID}/labels/${LABEL_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
