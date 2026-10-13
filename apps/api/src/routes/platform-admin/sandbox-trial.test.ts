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

const mockSetTrial = vi.fn();
const mockCurrentRows = vi.fn();
const mockTx = {
  select: () => ({
    from: () => ({ where: () => ({ limit: () => mockCurrentRows() }) }),
  }),
};
vi.mock("@platform/db", () => ({
  tenants: { id: "id", isSandbox: "isSandbox", trialEndsAt: "trialEndsAt" },
  withPlatformAdminContext: (fn: (tx: unknown) => unknown) => fn(mockTx),
  setSandboxTrialEndsAt: (...args: unknown[]) => mockSetTrial(...args),
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
  mockSetTrial.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /sandboxes/:tenantId/trial (extend)", () => {
  it("adds the days to an active trial's current end", async () => {
    const currentEnd = new Date(NOW.getTime() + 5 * DAY);
    mockCurrentRows.mockResolvedValue([{ trialEndsAt: currentEnd }]);

    const res = await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 7 });

    expect(res.status).toBe(200);
    const expected = new Date(currentEnd.getTime() + 7 * DAY);
    expect(mockSetTrial).toHaveBeenCalledWith(TENANT_ID, expected, "pa-1");
    expect(await res.json()).toEqual({
      data: { trialEndsAt: expected.toISOString() },
    });
  });

  it("counts from now for an expired trial, reactivating it", async () => {
    mockCurrentRows.mockResolvedValue([
      { trialEndsAt: new Date(NOW.getTime() - 3 * DAY) },
    ]);

    await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 7 });

    expect(mockSetTrial).toHaveBeenCalledWith(
      TENANT_ID,
      new Date(NOW.getTime() + 7 * DAY),
      "pa-1",
    );
  });

  it("counts from now when no trial end is set", async () => {
    mockCurrentRows.mockResolvedValue([{ trialEndsAt: null }]);

    await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 2 });

    expect(mockSetTrial).toHaveBeenCalledWith(
      TENANT_ID,
      new Date(NOW.getTime() + 2 * DAY),
      "pa-1",
    );
  });

  it("clears the cached trial so the change applies immediately", async () => {
    mockCurrentRows.mockResolvedValue([{ trialEndsAt: null }]);

    await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 3 });

    expect(mockInvalidate).toHaveBeenCalledWith(TENANT_ID);
  });

  it("returns 404 without updating when no sandbox has that id", async () => {
    mockCurrentRows.mockResolvedValue([]);

    const res = await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 3 });

    expect(res.status).toBe(404);
    expect(mockSetTrial).not.toHaveBeenCalled();
  });

  it("returns 404 when the database function refuses (e.g. being deleted)", async () => {
    mockCurrentRows.mockResolvedValue([{ trialEndsAt: null }]);
    mockSetTrial.mockResolvedValue(false);

    const res = await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 3 });

    expect(res.status).toBe(404);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it.each([0, -1, 366, 1.5, "7"])(
    "rejects trialDays %s with 400",
    async (trialDays) => {
      const res = await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays });

      expect(res.status).toBe(400);
      expect(mockSetTrial).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed tenant id with 400", async () => {
    const res = await post("/sandboxes/not-a-uuid/trial", { trialDays: 3 });

    expect(res.status).toBe(400);
  });
});

describe("POST /sandboxes/:tenantId/trial/end", () => {
  it("ends the trial now, audited as sandbox.trial_ended", async () => {
    const res = await post(`/sandboxes/${TENANT_ID}/trial/end`);

    expect(res.status).toBe(200);
    expect(mockSetTrial).toHaveBeenCalledWith(
      TENANT_ID,
      NOW,
      "pa-1",
      "sandbox.trial_ended",
    );
    expect(await res.json()).toEqual({
      data: { trialEndsAt: NOW.toISOString() },
    });
  });

  it("clears the cached trial so sign-in stops on the next request", async () => {
    await post(`/sandboxes/${TENANT_ID}/trial/end`);

    expect(mockInvalidate).toHaveBeenCalledWith(TENANT_ID);
  });

  it("returns 404 when no active sandbox has that id", async () => {
    mockSetTrial.mockResolvedValue(false);

    const res = await post(`/sandboxes/${TENANT_ID}/trial/end`);

    expect(res.status).toBe(404);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("rejects a malformed tenant id with 400", async () => {
    const res = await post("/sandboxes/not-a-uuid/trial/end");

    expect(res.status).toBe(400);
    expect(mockSetTrial).not.toHaveBeenCalled();
  });
});
