import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const mockRequireRole = vi.fn(
  (..._roles: string[]) =>
    async (_c: Context, next: Next): Promise<void> => {
      await next();
    },
);

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: "tenant-from-auth",
        userId: "u-admin",
        roles: ["admin"],
        email: "admin@example.com",
      });
      await next();
    },
  requireRole: (...roles: string[]) => mockRequireRole(...roles),
}));

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

const mockQueryAuditLog = vi.fn();
vi.mock("@platform/audit", () => ({
  queryAuditLog: (...args: unknown[]) => mockQueryAuditLog(...args),
  ALL_AUDIT_ACTIONS: [
    "created",
    "access.revoked",
    "notification.channel_failed",
  ],
}));

const { getAuditLogHandler } = await import("./audit.js");
// requireRole(...) is called once, when the handler chain is built.
const roleCallsAtLoad = [...mockRequireRole.mock.calls];

function makeApp(): Hono<{ Variables: { auth: AuthContext } }> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/audit", ...getAuditLogHandler);
  return app;
}

describe("GET /admin/audit", () => {
  beforeEach(() => {
    mockQueryAuditLog.mockReset();
    mockQueryAuditLog.mockResolvedValue({ entries: [], nextCursor: null });
  });

  it("is admin-only", () => {
    expect(roleCallsAtLoad).toEqual([["admin"]]);
  });

  it("passes a valid action to the query, with the tenant taken from auth", async () => {
    const res = await makeApp().request("/audit?action=access.revoked");

    expect(res.status).toBe(200);
    expect(mockQueryAuditLog).toHaveBeenCalledTimes(1);
    expect(mockQueryAuditLog.mock.calls[0]?.[1]).toMatchObject({
      tenantId: "tenant-from-auth",
      action: "access.revoked",
    });
  });

  it("ignores a tenantId in the query string", async () => {
    await makeApp().request("/audit?action=created&tenantId=some-other-tenant");

    expect(mockQueryAuditLog.mock.calls[0]?.[1]).toMatchObject({
      tenantId: "tenant-from-auth",
    });
  });

  it("combines action with the existing resource filters in one query", async () => {
    const id = "11111111-1111-4111-8111-111111111111";

    await makeApp().request(
      `/audit?action=notification.channel_failed&resourceType=ticket&resourceId=${id}`,
    );

    expect(mockQueryAuditLog.mock.calls[0]?.[1]).toMatchObject({
      action: "notification.channel_failed",
      resourceType: "ticket",
      resourceId: id,
    });
  });

  it("leaves action undefined when it is not given", async () => {
    await makeApp().request("/audit?resourceType=ticket");

    expect(mockQueryAuditLog.mock.calls[0]?.[1]).toMatchObject({
      action: undefined,
    });
  });

  it("returns the page envelope", async () => {
    mockQueryAuditLog.mockResolvedValue({
      entries: [{ id: "e-1" }],
      nextCursor: "e-1",
    });

    const res = await makeApp().request("/audit?action=created");

    expect(await res.json()).toEqual({
      data: [{ id: "e-1" }],
      meta: { hasMore: true, nextCursor: "e-1" },
    });
  });

  it("rejects an unknown action with a 400 VALIDATION_ERROR, not an empty page", async () => {
    const res = await makeApp().request("/audit?action=not.a.real.action");

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fields: Array<{ field: string }>;
    };
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.fields.map((f) => f.field)).toContain("action");
    expect(mockQueryAuditLog).not.toHaveBeenCalled();
  });

  it("accepts one action only: a repeated parameter is rejected", async () => {
    const res = await makeApp().request(
      "/audit?action=created&action=access.revoked",
    );

    expect(res.status).toBe(400);
    expect(mockQueryAuditLog).not.toHaveBeenCalled();
  });

  it("rejects an empty action rather than treating it as no filter", async () => {
    const res = await makeApp().request("/audit?action=");

    expect(res.status).toBe(400);
    expect(mockQueryAuditLog).not.toHaveBeenCalled();
  });
});
