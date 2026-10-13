import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { PlatformAdminAuthContext } from "@platform/auth";

const { mockInvalidate } = vi.hoisted(() => ({ mockInvalidate: vi.fn() }));

vi.mock("@platform/auth", () => ({
  requirePlatformAdmin:
    () =>
    async (
      c: Context<{ Variables: { platformAdmin: PlatformAdminAuthContext } }>,
      next: Next,
    ) => {
      c.set("platformAdmin", {
        userId: "pa-1",
        roles: ["platform_admin"],
        email: "ops@openwind.io",
        displayName: "Ops",
      });
      await next();
    },
  invalidateTenantStatusCache: (id: string) => mockInvalidate(id),
}));

const mockExtend = vi.fn();
const mockEnd = vi.fn();
const mockCurrentRows = vi.fn();
const mockTx = {
  select: () => ({
    from: () => ({ where: () => ({ limit: () => mockCurrentRows() }) }),
  }),
};
vi.mock("@platform/db", () => ({
  tenants: { id: "id", isSandbox: "isSandbox", trialEndsAt: "trialEndsAt" },
  withPlatformAdminContext: (fn: (tx: unknown) => unknown) => fn(mockTx),
  extendSandboxTrial: (...args: unknown[]) => mockExtend(...args),
  endSandboxTrial: (...args: unknown[]) => mockEnd(...args),
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ["eq", a, b],
  and: (...args: unknown[]) => ["and", ...args],
}));

const { sandboxTrialHandler, sandboxTrialEndHandler } =
  await import("./sandbox-trial.js");

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-12T12:00:00.000Z");
const DAY = 86_400_000;

function makeApp(): Hono<{
  Variables: { platformAdmin: PlatformAdminAuthContext };
}> {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.post("/sandboxes/:tenantId/trial", ...sandboxTrialHandler);
  app.post("/sandboxes/:tenantId/trial/end", ...sandboxTrialEndHandler);
  return app;
}

function post(path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    makeApp().request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /sandboxes/:tenantId/trial (extend)", () => {
  it("extends atomically in the database and returns the new end", async () => {
    const newEnd = new Date(NOW.getTime() + 12 * DAY);
    mockExtend.mockResolvedValue(newEnd);

    const res = await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 7 });

    expect(res.status).toBe(200);
    expect(mockExtend).toHaveBeenCalledWith(TENANT_ID, 7, "pa-1");
    expect(await res.json()).toEqual({
      data: { trialEndsAt: newEnd.toISOString() },
    });
  });

  it("does not read the current end itself (no separate read-then-write)", async () => {
    mockExtend.mockResolvedValue(new Date(NOW.getTime() + DAY));

    await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 1 });

    expect(mockCurrentRows).not.toHaveBeenCalled();
  });

  it("clears the cached trial so the change applies immediately", async () => {
    mockExtend.mockResolvedValue(new Date(NOW.getTime() + DAY));

    await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 3 });

    expect(mockInvalidate).toHaveBeenCalledWith(TENANT_ID);
  });

  it("returns 404 when no active sandbox has that id", async () => {
    mockExtend.mockResolvedValue(null);

    const res = await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 3 });

    expect(res.status).toBe(404);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it.each([0, -1, 366, 1.5, "7"])(
    "rejects trialDays %s with 400",
    async (trialDays) => {
      const res = await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays });

      expect(res.status).toBe(400);
      expect(mockExtend).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed tenant id with 400", async () => {
    const res = await post("/sandboxes/not-a-uuid/trial", { trialDays: 3 });

    expect(res.status).toBe(400);
  });
});

describe("POST /sandboxes/:tenantId/trial/end", () => {
  it("ends a running trial now", async () => {
    mockCurrentRows.mockResolvedValue([
      { trialEndsAt: new Date(NOW.getTime() + 5 * DAY) },
    ]);
    mockEnd.mockResolvedValue(NOW);

    const res = await post(`/sandboxes/${TENANT_ID}/trial/end`);

    expect(res.status).toBe(200);
    expect(mockEnd).toHaveBeenCalledWith(TENANT_ID, "pa-1");
    expect(mockInvalidate).toHaveBeenCalledWith(TENANT_ID);
    expect(await res.json()).toEqual({
      data: { trialEndsAt: NOW.toISOString() },
    });
  });

  it("returns 409 NO_ACTIVE_TRIAL, changing nothing, when no trial is set", async () => {
    mockCurrentRows.mockResolvedValue([{ trialEndsAt: null }]);

    const res = await post(`/sandboxes/${TENANT_ID}/trial/end`);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "NO_ACTIVE_TRIAL" });
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("returns 409 NO_ACTIVE_TRIAL when the trial has already ended", async () => {
    mockCurrentRows.mockResolvedValue([
      { trialEndsAt: new Date(NOW.getTime() - DAY) },
    ]);

    const res = await post(`/sandboxes/${TENANT_ID}/trial/end`);

    expect(res.status).toBe(409);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("returns 409 when the trial stops being active before the update lands", async () => {
    mockCurrentRows.mockResolvedValue([
      { trialEndsAt: new Date(NOW.getTime() + DAY) },
    ]);
    mockEnd.mockResolvedValue(null);

    const res = await post(`/sandboxes/${TENANT_ID}/trial/end`);

    expect(res.status).toBe(409);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("returns 404 when no sandbox has that id", async () => {
    mockCurrentRows.mockResolvedValue([]);

    const res = await post(`/sandboxes/${TENANT_ID}/trial/end`);

    expect(res.status).toBe(404);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("rejects a malformed tenant id with 400", async () => {
    const res = await post("/sandboxes/not-a-uuid/trial/end");

    expect(res.status).toBe(400);
    expect(mockEnd).not.toHaveBeenCalled();
  });
});
