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

// The real requireFreshMfa is unit-tested in packages/auth; here it is a switch, so these
// tests prove the route is mounted behind it and never reaches its work without it (#865).
const freshState = vi.hoisted(() => ({ fresh: true }));

vi.mock("@platform/auth", () => ({
  requireFreshMfa:
    () =>
    async (
      c: Context<{ Variables: { platformAdmin: PlatformAdminAuthContext } }>,
      next: Next,
    ): Promise<Response | void> => {
      if (!freshState.fresh) {
        return c.json(
          { error: "MFA_REAUTH_REQUIRED", message: "Enter a new code" },
          403,
        );
      }
      await next();
    },
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
vi.mock("../../lib/sandbox-reset-queue.js", () => ({
  sandboxResetQueue: { add: (...args: unknown[]) => mockQueueAdd(...args) },
  sandboxResetQueueEvents: {},
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { sandboxResetHandler } = await import("./sandbox-reset.js");

function makeApp() {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.post("/sandboxes/:tenantId/reset", ...sandboxResetHandler);
  return app;
}

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  freshState.fresh = true;
  mockSelectRows.mockResolvedValue([{ id: TENANT_ID, isSandbox: true }]);
});

describe("POST /sandboxes/:tenantId/reset", () => {
  it("returns 403 MFA_REAUTH_REQUIRED without a fresh MFA verification, before any lookup or lock (#865)", async () => {
    freshState.fresh = false;

    const res = await makeApp().request(`/sandboxes/${TENANT_ID}/reset`, {
      method: "POST",
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "MFA_REAUTH_REQUIRED" });
    expect(mockSelectRows).not.toHaveBeenCalled();
    expect(mockAcquireTenantAdvisoryLock).not.toHaveBeenCalled();
  });

  it("returns 404 when no such tenant exists", async () => {
    mockSelectRows.mockResolvedValue([]);
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}/reset`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
    expect(mockAcquireTenantAdvisoryLock).not.toHaveBeenCalled();
  });

  it("returns 404 when the tenant exists but is not a sandbox", async () => {
    mockSelectRows.mockResolvedValue([{ id: TENANT_ID, isSandbox: false }]);
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}/reset`, {
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

    const res = await app.request(`/sandboxes/${TENANT_ID}/reset`, {
      method: "POST",
    });

    expect(res.status).toBe(409);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("acquires the lock, enqueues, awaits completion, releases the lock, and returns 200", async () => {
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

    const res = await app.request(`/sandboxes/${TENANT_ID}/reset`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { tenantId: TENANT_ID } });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "reset",
      { tenantId: TENANT_ID, requestedBy: "pa-1" },
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    expect(mockWaitUntilFinished).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  it("returns 503 and releases the lock when enqueueing fails", async () => {
    const mockRelease = vi.fn().mockResolvedValue(undefined);
    mockAcquireTenantAdvisoryLock.mockResolvedValue({
      acquired: true,
      release: mockRelease,
    });
    mockQueueAdd.mockRejectedValue(new Error("redis down"));
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}/reset`, {
      method: "POST",
    });

    expect(res.status).toBe(503);
    expect(mockRelease).toHaveBeenCalled();
  });

  it("returns 500 and releases the lock when the reset job itself fails", async () => {
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

    const res = await app.request(`/sandboxes/${TENANT_ID}/reset`, {
      method: "POST",
    });

    expect(res.status).toBe(500);
    expect(mockRelease).toHaveBeenCalled();
  });

  it("returns 504 RESET_TIMEOUT and releases the lock when the reset job times out waiting for worker (#864)", async () => {
    const mockRelease = vi.fn().mockResolvedValue(undefined);
    mockAcquireTenantAdvisoryLock.mockResolvedValue({
      acquired: true,
      release: mockRelease,
    });
    const mockWaitUntilFinished = vi
      .fn()
      .mockRejectedValue(new Error("Job job-1 timed out after 60000ms"));
    mockQueueAdd.mockResolvedValue({
      waitUntilFinished: mockWaitUntilFinished,
    });
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}/reset`, {
      method: "POST",
    });

    expect(res.status).toBe(504);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "RESET_TIMEOUT",
    });
    expect(mockRelease).toHaveBeenCalled();
  });

  it("still releases the lock even when release itself would otherwise mask a 200 response", async () => {
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

    const res = await app.request(`/sandboxes/${TENANT_ID}/reset`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(mockRelease).toHaveBeenCalled();
  });
});
