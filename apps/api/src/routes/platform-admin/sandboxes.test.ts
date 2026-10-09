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

const mockGetSandboxHandoverCredentials = vi.fn();
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
  getSandboxHandoverCredentials: (...args: unknown[]) =>
    mockGetSandboxHandoverCredentials(...args),
}));

const mockCheckSandboxQuota = vi.fn();
const mockDbInsertValues = vi.fn().mockResolvedValue(undefined);
const mockDbInsert = vi.fn(() => ({ values: mockDbInsertValues }));
const mockDbDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockDbDelete = vi.fn(() => ({ where: mockDbDeleteWhere }));
// select().from().where().limit() chain for the progress/handover routes' reads.
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
  db: {
    insert: (...args: unknown[]) => mockDbInsert(...args),
    delete: (...args: unknown[]) => mockDbDelete(...args),
  },
  sandboxProvisioningJobs: {
    id: "id",
    status: "status",
    currentStep: "currentStep",
    completedSteps: "completedSteps",
    totalSteps: "totalSteps",
    error: "error",
    resultTenantId: "resultTenantId",
  },
  withPlatformAdminContext: (fn: (tx: unknown) => unknown) => fn(mockTx),
  checkSandboxQuota: (...args: unknown[]) => mockCheckSandboxQuota(...args),
  // Real, minimal re-implementation (not mocked away) so these tests exercise the actual
  // allow-list logic, not a stand-in that could silently diverge from
  // packages/db/src/platform-admin-view.ts.
  toProvisioningProgressView: (row: {
    id: string;
    status: string;
    currentStep: string | null;
    completedSteps: number;
    totalSteps: number;
    error: string | null;
  }) => ({
    id: row.id,
    status: row.status,
    currentStep: row.currentStep,
    completedSteps: row.completedSteps,
    totalSteps: row.totalSteps,
    error: row.error,
  }),
}));

vi.mock("drizzle-orm", () => ({ eq: (a: unknown, b: unknown) => [a, b] }));

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

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { createSandboxHandler, sandboxProgressHandler, sandboxHandoverHandler } =
  await import("./sandboxes.js");

function makeApp() {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.post("/sandboxes", ...createSandboxHandler);
  app.get("/sandboxes/:jobId/progress", ...sandboxProgressHandler);
  app.get("/sandboxes/:jobId/handover", ...sandboxHandoverHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckSandboxQuota.mockResolvedValue({
    allowed: true,
    current: 1,
    limit: 10,
  });
  mockDbInsertValues.mockResolvedValue(undefined);
  mockQueueAdd.mockResolvedValue({ id: "job-1" });
  mockEnforceSandboxProvisioningRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 2,
    resetAt: 0,
  });
  mockGetSandboxHandoverCredentials.mockResolvedValue(null);
});

describe("POST /platform-admin/sandboxes", () => {
  it("inserts a pending job row, enqueues with the same id, and returns it", async () => {
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

    const body = (await res.json()) as { data: { jobId: string } };
    expect(typeof body.data.jobId).toBe("string");
    expect(body.data.jobId.length).toBeGreaterThan(0);

    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: body.data.jobId,
        requestedBy: "pa-1",
        orgName: "Acme Sandbox",
        status: "pending",
      }),
    );
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "provision",
      { orgName: "Acme Sandbox", trialDays: 14, requestedBy: "pa-1" },
      { jobId: body.data.jobId },
    );
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
      expect.anything(),
    );
  });

  it("returns 409 and never inserts or enqueues when the platform admin is over their active-sandbox quota", async () => {
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
    expect(mockDbInsertValues).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("returns 429 and never checks quota, inserts, or enqueues when the per-platform_admin rate limit is exceeded", async () => {
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
    expect(mockDbInsertValues).not.toHaveBeenCalled();
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

  it("returns 400 for an all-symbol orgName, which would otherwise produce a leading-dash slug (review finding, PR #804)", async () => {
    const res = await makeApp().request("/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgName: "!!!", trialDays: 14 }),
    });

    expect(res.status).toBe(400);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("returns 503 and deletes the pending job row when enqueuing fails (review finding, PR #804/#805)", async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error("redis down"));

    const res = await makeApp().request("/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgName: "Acme Sandbox", trialDays: 14 }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "ENQUEUE_FAILED",
    });
    // The row inserted before the failed enqueue must not remain orphaned at "pending".
    expect(mockDbInsertValues).toHaveBeenCalledTimes(1);
    expect(mockDbDelete).toHaveBeenCalledTimes(1);
    expect(mockDbDeleteWhere).toHaveBeenCalledTimes(1);
  });
});

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const TENANT_ID = "33333333-3333-4333-8333-333333333333";

describe("GET /platform-admin/sandboxes/:jobId/progress", () => {
  it("returns the progress view for an existing job", async () => {
    mockSelectRows.mockResolvedValueOnce([
      {
        id: JOB_ID,
        status: "running",
        currentStep: "creating accounts (3/11)",
        completedSteps: 4,
        totalSteps: 14,
        error: null,
      },
    ]);

    const res = await makeApp().request(`/sandboxes/${JOB_ID}/progress`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: JOB_ID,
        status: "running",
        currentStep: "creating accounts (3/11)",
        completedSteps: 4,
        totalSteps: 14,
        error: null,
      },
    });
  });

  it("returns 404 for an unknown (but validly-shaped) job id", async () => {
    mockSelectRows.mockResolvedValueOnce([]);

    const res = await makeApp().request(`/sandboxes/${OTHER_JOB_ID}/progress`);

    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed job id, never reaching the database", async () => {
    const res = await makeApp().request("/sandboxes/not-a-uuid/progress");

    expect(res.status).toBe(400);
    expect(mockSelectRows).not.toHaveBeenCalled();
  });
});

describe("GET /platform-admin/sandboxes/:jobId/handover", () => {
  it("returns the handover artifact once the job has completed and Redis still has it (review finding, PR #805: keyed on jobId, not tenantId)", async () => {
    mockSelectRows.mockResolvedValueOnce([
      { resultTenantId: TENANT_ID, status: "completed" },
    ]);
    mockGetSandboxHandoverCredentials.mockResolvedValueOnce({
      seededAccounts: [{ email: "admin@example.com", role: "admin" }],
      defaultPassword: "Ow-abc-9!",
    });

    const res = await makeApp().request(`/sandboxes/${JOB_ID}/handover`);

    expect(res.status).toBe(200);
    expect(mockGetSandboxHandoverCredentials).toHaveBeenCalledWith(TENANT_ID);
    expect(await res.json()).toEqual({
      data: {
        tenantId: TENANT_ID,
        seededAccounts: [{ email: "admin@example.com", role: "admin" }],
        defaultPassword: "Ow-abc-9!",
      },
    });
  });

  it("returns 409 when the job exists but hasn't completed yet, without reading Redis", async () => {
    mockSelectRows.mockResolvedValueOnce([
      { resultTenantId: TENANT_ID, status: "running" },
    ]);

    const res = await makeApp().request(`/sandboxes/${JOB_ID}/handover`);

    expect(res.status).toBe(409);
    expect(mockGetSandboxHandoverCredentials).not.toHaveBeenCalled();
  });

  it("returns 409 when the job row has no resultTenantId yet, without reading Redis", async () => {
    mockSelectRows.mockResolvedValueOnce([
      { resultTenantId: null, status: "running" },
    ]);

    const res = await makeApp().request(`/sandboxes/${JOB_ID}/handover`);

    expect(res.status).toBe(409);
    expect(mockGetSandboxHandoverCredentials).not.toHaveBeenCalled();
  });

  it("returns 404 when no provisioning job exists for this (validly-shaped) job id", async () => {
    mockSelectRows.mockResolvedValueOnce([]);

    const res = await makeApp().request(`/sandboxes/${OTHER_JOB_ID}/handover`);

    expect(res.status).toBe(404);
  });

  it("returns 404 when the job completed but the 7-day handover window has expired", async () => {
    mockSelectRows.mockResolvedValueOnce([
      { resultTenantId: TENANT_ID, status: "completed" },
    ]);
    mockGetSandboxHandoverCredentials.mockResolvedValueOnce(null);

    const res = await makeApp().request(`/sandboxes/${JOB_ID}/handover`);

    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed job id, never reaching the database", async () => {
    const res = await makeApp().request("/sandboxes/not-a-uuid/handover");

    expect(res.status).toBe(400);
    expect(mockSelectRows).not.toHaveBeenCalled();
  });
});
