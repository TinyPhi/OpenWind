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

const mockSelectRows = vi.fn();
const mockTx = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => mockSelectRows(),
      }),
    }),
  }),
};

vi.mock("@platform/db", () => ({
  tenants: { id: "id", isSandbox: "isSandbox" },
  withPlatformAdminContext: (fn: (tx: unknown) => unknown) => fn(mockTx),
  acquireTenantAdvisoryLock: (...args: unknown[]) =>
    mockAcquireTenantAdvisoryLock(...args),
}));

vi.mock("drizzle-orm", () => ({ eq: (a: unknown, b: unknown) => [a, b] }));

const mockAcquireTenantAdvisoryLock = vi.fn();
const mockQueueAdd = vi.fn();
vi.mock("../../lib/sandbox-delete-queue.js", () => ({
  sandboxDeleteQueue: { add: (...args: unknown[]) => mockQueueAdd(...args) },
  sandboxDeleteQueueEvents: {},
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { sandboxDeleteHandler } = await import("./sandbox-delete.js");

function makeApp() {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.post("/sandboxes/:tenantId/delete", ...sandboxDeleteHandler);
  return app;
}

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectRows.mockResolvedValue([{ id: TENANT_ID, isSandbox: true }]);
});

describe("POST /sandboxes/:tenantId/delete", () => {
  it("returns 404 when no such tenant exists", async () => {
    mockSelectRows.mockResolvedValue([]);
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}/delete`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
    expect(mockAcquireTenantAdvisoryLock).not.toHaveBeenCalled();
  });

  it("returns 404 when the tenant exists but is not a sandbox", async () => {
    mockSelectRows.mockResolvedValue([{ id: TENANT_ID, isSandbox: false }]);
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}/delete`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
    expect(mockAcquireTenantAdvisoryLock).not.toHaveBeenCalled();
  });

  it("returns 409 when the sandbox-lifecycle lock is already held", async () => {
    mockAcquireTenantAdvisoryLock.mockResolvedValue({
      acquired: false,
      release: vi.fn(),
    });
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}/delete`, {
      method: "POST",
    });

    expect(res.status).toBe(409);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("acquires the pre-check lock, enqueues, awaits completion, releases the lock, and returns 200", async () => {
    const mockRelease = vi.fn().mockResolvedValue(undefined);
    mockAcquireTenantAdvisoryLock.mockResolvedValue({
      acquired: true,
      release: mockRelease,
    });
    const mockWaitUntilFinished = vi.fn().mockResolvedValue(undefined);
    mockQueueAdd.mockResolvedValue({
      waitUntilFinished: mockWaitUntilFinished,
    });
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}/delete`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { tenantId: TENANT_ID } });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "delete",
      { tenantId: TENANT_ID, requestedBy: "pa-1" },
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    expect(mockWaitUntilFinished).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  it("returns 503 and releases the pre-check lock when enqueueing fails", async () => {
    const mockRelease = vi.fn().mockResolvedValue(undefined);
    mockAcquireTenantAdvisoryLock.mockResolvedValue({
      acquired: true,
      release: mockRelease,
    });
    mockQueueAdd.mockRejectedValue(new Error("redis down"));
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}/delete`, {
      method: "POST",
    });

    expect(res.status).toBe(503);
    expect(mockRelease).toHaveBeenCalled();
  });

  it("returns 500 when the delete job itself fails", async () => {
    const mockRelease = vi.fn().mockResolvedValue(undefined);
    mockAcquireTenantAdvisoryLock.mockResolvedValue({
      acquired: true,
      release: mockRelease,
    });
    const mockWaitUntilFinished = vi
      .fn()
      .mockRejectedValue(new Error("job failed"));
    mockQueueAdd.mockResolvedValue({
      waitUntilFinished: mockWaitUntilFinished,
    });
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}/delete`, {
      method: "POST",
    });

    expect(res.status).toBe(500);
    expect(mockRelease).toHaveBeenCalled();
  });

  it("still returns 200 even when the pre-check lock's release itself fails", async () => {
    const mockRelease = vi.fn().mockRejectedValue(new Error("unlock blip"));
    mockAcquireTenantAdvisoryLock.mockResolvedValue({
      acquired: true,
      release: mockRelease,
    });
    const mockWaitUntilFinished = vi.fn().mockResolvedValue(undefined);
    mockQueueAdd.mockResolvedValue({
      waitUntilFinished: mockWaitUntilFinished,
    });
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}/delete`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(mockRelease).toHaveBeenCalled();
  });
});
