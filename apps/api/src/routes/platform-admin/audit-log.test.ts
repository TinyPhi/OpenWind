import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { PlatformAdminAuthContext } from "@platform/auth";

const { mockPlatformAdmin } = vi.hoisted(() => ({
  mockPlatformAdmin: {
    userId: "pa-1",
    roles: ["platform_admin"],
    email: "ops@openwind.io",
    displayName: "Ops",
  },
}));

vi.mock("@platform/auth", () => ({
  requirePlatformAdmin:
    () =>
    async (
      c: Context<{ Variables: { platformAdmin: PlatformAdminAuthContext } }>,
      next: Next,
    ) => {
      c.set("platformAdmin", mockPlatformAdmin as PlatformAdminAuthContext);
      await next();
    },
}));

const mockListPlatformAdminAuditLog = vi.fn();
vi.mock("@platform/db", () => ({
  listPlatformAdminAuditLog: (...args: unknown[]) =>
    mockListPlatformAdminAuditLog(...args),
}));

const { auditLogHandler } = await import("./audit-log.js");

function makeApp() {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.get("/audit-log", ...auditLogHandler);
  return app;
}

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const ENTRY_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /audit-log", () => {
  it("returns entries newest-first with the default limit", async () => {
    mockListPlatformAdminAuditLog.mockResolvedValue([
      {
        id: ENTRY_ID,
        actorSub: "pa-1",
        action: "sandbox.created",
        targetTenantId: TENANT_ID,
        createdAt: "2026-10-09T00:00:00.000Z",
      },
    ]);
    const app = makeApp();

    const res = await app.request("/audit-log");

    expect(res.status).toBe(200);
    expect(mockListPlatformAdminAuditLog).toHaveBeenCalledWith({
      limit: 50,
      before: undefined,
      targetTenantId: undefined,
    });
    const body = await res.json();
    expect(body.data).toEqual([
      {
        id: ENTRY_ID,
        actorSub: "pa-1",
        action: "sandbox.created",
        targetTenantId: TENANT_ID,
        createdAt: "2026-10-09T00:00:00.000Z",
      },
    ]);
  });

  it("passes through an explicit limit and before cursor", async () => {
    mockListPlatformAdminAuditLog.mockResolvedValue([]);
    const app = makeApp();

    await app.request(`/audit-log?limit=10&before=${ENTRY_ID}`);

    expect(mockListPlatformAdminAuditLog).toHaveBeenCalledWith({
      limit: 10,
      before: ENTRY_ID,
      targetTenantId: undefined,
    });
  });

  it("passes through a targetTenantId filter", async () => {
    mockListPlatformAdminAuditLog.mockResolvedValue([]);
    const app = makeApp();

    const res = await app.request(`/audit-log?targetTenantId=${TENANT_ID}`);

    expect(res.status).toBe(200);
    expect(mockListPlatformAdminAuditLog).toHaveBeenCalledWith({
      limit: 50,
      before: undefined,
      targetTenantId: TENANT_ID,
    });
  });

  it("rejects a malformed targetTenantId", async () => {
    const app = makeApp();

    const res = await app.request("/audit-log?targetTenantId=nope");

    expect(res.status).toBe(400);
    expect(mockListPlatformAdminAuditLog).not.toHaveBeenCalled();
  });

  it("rejects a limit above 100", async () => {
    const app = makeApp();

    const res = await app.request("/audit-log?limit=500");

    expect(res.status).toBe(400);
    expect(mockListPlatformAdminAuditLog).not.toHaveBeenCalled();
  });

  it("rejects a malformed before cursor", async () => {
    const app = makeApp();

    const res = await app.request("/audit-log?before=not-a-uuid");

    expect(res.status).toBe(400);
    expect(mockListPlatformAdminAuditLog).not.toHaveBeenCalled();
  });
});
