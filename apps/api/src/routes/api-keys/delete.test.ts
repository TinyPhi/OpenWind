import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAuth = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["admin"] as string[],
  email: "test@example.com",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth as AuthContext);
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
  requireIntrospection: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

let mockUpdateReturns: unknown[] = [{ id: "key-1" }];
const mockUpdateSet = vi.fn();
const mockWhere = vi.fn();
const mockWriteAuditEntry = vi.fn();

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      update: () => tx,
      set: (...args: unknown[]) => {
        mockUpdateSet(...args);
        return tx;
      },
      where: (...args: unknown[]) => {
        mockWhere(...args);
        return tx;
      },
      returning: () => Promise.resolve(mockUpdateReturns),
    };
    return fn(tx);
  },
  apiKeys: {},
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => {
    mockWriteAuditEntry(...args);
    return Promise.resolve();
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  isNull: vi.fn((...args: unknown[]) => ({ op: "isNull", args })),
}));

const { deleteApiKeyHandler } = await import("./delete.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.delete("/:id", ...deleteApiKeyHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DELETE /api-keys/:id — soft-revoke (ADR-008 Decision #4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateReturns = [{ id: "key-1" }];
  });

  it("returns 204 and sets revokedAt/revokedBy instead of deleting the row", async () => {
    const res = await makeApp().request("/key-1", { method: "DELETE" });
    expect(res.status).toBe(204);

    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(setArg.revokedAt).toBeInstanceOf(Date);
    expect(setArg.revokedBy).toBe(mockAuth.userId);
  });

  it("guards the update with isNull(revokedAt) so an already-revoked key isn't double-revoked", async () => {
    await makeApp().request("/key-1", { method: "DELETE" });
    const [andCall] = mockWhere.mock.calls[0];
    expect(andCall.op).toBe("and");
    expect(andCall.args.some((a: { op: string }) => a.op === "isNull")).toBe(
      true,
    );
  });

  it("returns 404 when the key doesn't exist or is already revoked", async () => {
    mockUpdateReturns = [];
    const res = await makeApp().request("/key-1", { method: "DELETE" });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
  });

  it("writes an audit entry only when a row was actually revoked", async () => {
    await makeApp().request("/key-1", { method: "DELETE" });
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const entry = mockWriteAuditEntry.mock.calls[0][1];
    expect(entry.action).toBe("deleted");
    expect(entry.resourceType).toBe("api_key");
  });

  it("does not write an audit entry when nothing was revoked (404 case)", async () => {
    mockUpdateReturns = [];
    await makeApp().request("/key-1", { method: "DELETE" });
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });
});
