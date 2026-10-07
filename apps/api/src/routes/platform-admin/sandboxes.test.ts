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

const mockCheckSandboxQuota = vi.fn();
vi.mock("@platform/db", () => ({
  withPlatformAdminContext: (fn: (tx: unknown) => unknown) => fn({}),
  checkSandboxQuota: (...args: unknown[]) => mockCheckSandboxQuota(...args),
}));

vi.mock("@platform/config", () => ({
  env: { PLATFORM_ADMIN_MAX_ACTIVE_SANDBOXES: 10 },
}));

const mockQueueAdd = vi.fn();
vi.mock("../../lib/sandbox-provisioning-queue.js", () => ({
  sandboxProvisioningQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

const mockEnforceSandboxProvisioningRateLimit = vi.fn();
vi.mock("../../lib/rate-limit-tiers.js", () => ({
  enforceSandboxProvisioningRateLimit: (...args: unknown[]) =>
    mockEnforceSandboxProvisioningRateLimit(...args),
}));

const { createSandboxHandler } = await import("./sandboxes.js");

function makeApp() {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.post("/sandboxes", ...createSandboxHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckSandboxQuota.mockResolvedValue({
    allowed: true,
    current: 1,
    limit: 10,
  });
  mockQueueAdd.mockResolvedValue({ id: "job-1" });
  mockEnforceSandboxProvisioningRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 2,
    resetAt: 0,
  });
});

describe("POST /platform-admin/sandboxes", () => {
  it("enqueues a provisioning job and returns its id", async () => {
    const res = await makeApp().request("/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgName: "Acme Sandbox", trialDays: 14 }),
    });

    expect(res.status).toBe(202);
    expect(mockEnforceSandboxProvisioningRateLimit).toHaveBeenCalledWith(
      "pa-1",
    );
    expect(mockCheckSandboxQuota).toHaveBeenCalledWith(
      expect.anything(),
      "pa-1",
      10,
    );
    expect(mockQueueAdd).toHaveBeenCalledWith("provision", {
      orgName: "Acme Sandbox",
      trialDays: 14,
      requestedBy: "pa-1",
    });
    expect(await res.json()).toEqual({ data: { jobId: "job-1" } });
  });

  it("defaults trialDays to 14 when omitted", async () => {
    await makeApp().request("/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgName: "Acme Sandbox" }),
    });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "provision",
      expect.objectContaining({ trialDays: 14 }),
    );
  });

  it("returns 409 and never enqueues when the platform admin is over their active-sandbox quota", async () => {
    mockCheckSandboxQuota.mockResolvedValueOnce({
      allowed: false,
      current: 10,
      limit: 10,
    });

    const res = await makeApp().request("/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgName: "Acme Sandbox", trialDays: 14 }),
    });

    expect(res.status).toBe(409);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("returns 429 and never checks quota or enqueues when the per-platform_admin rate limit is exceeded", async () => {
    mockEnforceSandboxProvisioningRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const res = await makeApp().request("/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgName: "Acme Sandbox", trialDays: 14 }),
    });

    expect(res.status).toBe(429);
    expect(mockCheckSandboxQuota).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing orgName", async () => {
    const res = await makeApp().request("/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trialDays: 14 }),
    });

    expect(res.status).toBe(400);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
