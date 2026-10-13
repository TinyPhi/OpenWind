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
vi.mock("@platform/db", () => ({
  setSandboxTrialEndsAt: (...args: unknown[]) => mockSetTrial(...args),
}));

const { sandboxTrialHandler } = await import("./sandbox-trial.js");

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-12T12:00:00.000Z");

function makeApp(): Hono<{
  Variables: { platformAdmin: PlatformAdminAuthContext };
}> {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.post("/sandboxes/:tenantId/trial", ...sandboxTrialHandler);
  return app;
}

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    makeApp().request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

describe("POST /sandboxes/:tenantId/trial", () => {
  it("sets the trial to end trialDays from now, as the acting admin, and returns the new end", async () => {
    mockSetTrial.mockResolvedValue(true);

    const res = await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 7 });

    expect(res.status).toBe(200);
    const expected = new Date("2026-10-19T12:00:00.000Z");
    expect(mockSetTrial).toHaveBeenCalledWith(TENANT_ID, expected, "pa-1");
    expect(await res.json()).toEqual({
      data: { trialEndsAt: expected.toISOString() },
    });
  });

  it("clears the cached trial so the change applies immediately", async () => {
    mockSetTrial.mockResolvedValue(true);

    await post(`/sandboxes/${TENANT_ID}/trial`, { trialDays: 3 });

    expect(mockInvalidate).toHaveBeenCalledWith(TENANT_ID);
  });

  it("returns 404 when no active sandbox has that id", async () => {
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
    expect(mockSetTrial).not.toHaveBeenCalled();
  });
});
