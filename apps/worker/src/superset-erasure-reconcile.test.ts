import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAddQueue,
  mockGetJob,
  mockCount,
  mockLogger,
  mockWithTenantContext,
  mockListSweepTenants,
  mockForEachTenant,
  mockReadSelfcheck,
  mockResolveMode,
  mockWriteUnreconciledEntries,
  mockEnqueueErasure,
  mockJobId,
  mockEnv,
  mockTxSelect,
  fakeTx,
} = vi.hoisted(() => {
  const mockTxSelect = vi.fn();
  const fakeTx = {
    select: mockTxSelect,
  };
  return {
    mockAddQueue: vi.fn(),
    mockGetJob: vi.fn(),
    mockCount: vi.fn(),
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    mockWithTenantContext: vi.fn(),
    mockListSweepTenants: vi.fn(),
    mockForEachTenant: vi.fn(),
    mockReadSelfcheck: vi.fn(),
    mockResolveMode: vi.fn(),
    mockWriteUnreconciledEntries: vi.fn(),
    mockEnqueueErasure: vi.fn(),
    mockJobId: vi.fn(),
    mockEnv: {
      SUPERSET_DEPLOYMENT: "on" as "on" | "off",
      SUPERSET_OAUTH_CLIENT_ID: "client-id" as string | undefined,
    },
    mockTxSelect,
    fakeTx,
  };
});

vi.mock("@platform/telemetry", () => ({
  Worker: class {
    on = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
  },
  Queue: class {
    add = mockAddQueue;
    close = vi.fn().mockResolvedValue(undefined);
  },
  supersetErasureTotal: {
    add: mockCount,
  },
}));

vi.mock("@platform/config", () => ({
  env: mockEnv,
  supersetErasureMode: (e: typeof mockEnv) =>
    e.SUPERSET_DEPLOYMENT === "off"
      ? "off"
      : e.SUPERSET_OAUTH_CLIENT_ID
        ? "full"
        : "cache-only",
}));

vi.mock("@platform/logger", () => ({
  logger: mockLogger,
}));

vi.mock("@platform/db", () => ({
  adminAuditLog: {
    id: "id",
    tenantId: "tenant_id",
    resourceType: "resource_type",
    resourceId: "resource_id",
    action: "action",
    metadata: "metadata",
    createdAt: "created_at",
  },
  withTenantContext: mockWithTenantContext,
}));

vi.mock("@platform/redis", () => ({
  readSupersetSelfcheck: mockReadSelfcheck,
  resolveSupersetErasureMode: mockResolveMode,
  writeSupersetUnreconciledEntries: mockWriteUnreconciledEntries,
}));

vi.mock("./queues.js", () => ({
  connection: {},
  supersetErasureQueue: {
    getJob: mockGetJob,
  },
}));

vi.mock("./superset-erasure.js", () => ({
  enqueueSupersetErasure: mockEnqueueErasure,
  supersetErasureJobId: mockJobId,
}));

vi.mock("./tenant-sweep.js", () => ({
  listSweepTenants: mockListSweepTenants,
  forEachTenant: mockForEachTenant,
}));

const {
  reconcileTenantSupersetErasure,
  runSupersetErasureReconcile,
  scheduleSupersetErasureReconcile,
  stopSupersetErasureReconcileWorker,
  RECONCILE_REPEAT_JOB_ID,
  RECONCILE_START_JOB_ID,
} = await import("./superset-erasure-reconcile.js");

const TENANT_1 = "aaaaaaaa-1111-4000-a000-000000000001";
const TENANT_2 = "bbbbbbbb-2222-4000-b000-000000000002";
const SUBJECT = "393014043322875906";

function mockDbRows(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  mockTxSelect.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.SUPERSET_DEPLOYMENT = "on";
  mockEnv.SUPERSET_OAUTH_CLIENT_ID = "client-id";
  mockResolveMode.mockReturnValue({
    mode: "full",
    verified: true,
    overridden: false,
  });
  mockReadSelfcheck.mockResolvedValue(null);
  mockListSweepTenants.mockResolvedValue([
    { id: TENANT_1, trialEndsAt: null },
    { id: TENANT_2, trialEndsAt: null },
  ]);
  mockWithTenantContext.mockImplementation(
    (_t: string, fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx),
  );
  mockForEachTenant.mockImplementation(
    async (
      _sweep: string,
      tenantIds: string[],
      fn: (id: string) => Promise<unknown>,
    ) => {
      const results = new Map();
      for (const id of tenantIds) {
        results.set(id, await fn(id));
      }
      return { results, failedTenantIds: [] };
    },
  );
  mockGetJob.mockResolvedValue(undefined);
  mockJobId.mockReturnValue(`job-${SUBJECT}`);
  mockEnqueueErasure.mockResolvedValue(true);
  mockWriteUnreconciledEntries.mockResolvedValue(undefined);
});

describe("runSupersetErasureReconcile (#1138)", () => {
  it("skips the sweep when mode is not full and resets unreconciled count", async () => {
    mockResolveMode.mockReturnValue({
      mode: "cache-only",
      verified: true,
      overridden: false,
    });

    const summary = await runSupersetErasureReconcile();
    expect(summary.skipped).toBe(true);
    expect(mockListSweepTenants).not.toHaveBeenCalled();
    expect(mockWriteUnreconciledEntries).toHaveBeenCalledWith([]);
  });

  it("skips the sweep when deployment is off and resets unreconciled count", async () => {
    mockResolveMode.mockReturnValue({
      mode: "off",
      verified: true,
      overridden: false,
    });

    const summary = await runSupersetErasureReconcile();
    expect(summary.skipped).toBe(true);
    expect(mockListSweepTenants).not.toHaveBeenCalled();
    expect(mockWriteUnreconciledEntries).toHaveBeenCalledWith([]);
  });

  it("sweeps active tenants when mode is full and writes total older than 1h to Redis", async () => {
    const now = new Date();
    // Tenant 1 has 1 reconciled row (older than 1h), Tenant 2 has 1 reconciled row (newer)
    mockDbRows([
      {
        id: "audit-1",
        resourceType: "user",
        resourceId: "res-1",
        metadata: { userId: SUBJECT, wasMember: true },
        createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000), // 2 hours old
      },
    ]);

    const summary = await runSupersetErasureReconcile();
    expect(summary.skipped).toBe(false);
    expect(summary.tenantCount).toBe(2);
    expect(mockForEachTenant).toHaveBeenCalledWith(
      "superset-erasure-reconcile",
      [TENANT_1, TENANT_2],
      expect.any(Function),
    );
    expect(mockWriteUnreconciledEntries).toHaveBeenCalledWith([
      { tenantId: TENANT_1, subjectHash: "res-1" },
      { tenantId: TENANT_2, subjectHash: "res-1" },
    ]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantCount: 2,
        failedTenants: 0,
      }),
      "superset-erasure-reconcile: sweep complete",
    );
  });
});

describe("reconcileTenantSupersetErasure (#1138)", () => {
  it("re-enqueues unreconciled deleted user audit row and bumps counter", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-1",
        resourceId: "res-1",
        metadata: { userId: SUBJECT, wasMember: true },
        createdAt: new Date(now.getTime() - 30 * 60 * 1000), // 30m old
      },
    ]);

    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.reconciled).toBe(1);
    expect(result.olderThan1h).toBe(0);
    expect(mockEnqueueErasure).toHaveBeenCalledWith(
      { kind: "user", tenantId: TENANT_1, subject: SUBJECT },
      { force: undefined },
    );
    expect(mockCount).toHaveBeenCalledWith(1, { outcome: "reconciled" });
  });

  it("passes force: true when mode is overridden by Superset selfcheck", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-1",
        resourceId: "res-1",
        metadata: { userId: SUBJECT, wasMember: true },
        createdAt: new Date(now.getTime() - 30 * 60 * 1000),
      },
    ]);

    await reconcileTenantSupersetErasure(TENANT_1, now, { force: true });
    expect(mockEnqueueErasure).toHaveBeenCalledWith(
      { kind: "user", tenantId: TENANT_1, subject: SUBJECT },
      { force: true },
    );
  });

  it("counts rows older than 1 hour for the gauge and collects entries", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-1",
        resourceType: "user",
        resourceId: "res-1",
        metadata: { userId: SUBJECT, wasMember: true },
        createdAt: new Date(now.getTime() - 90 * 60 * 1000), // 1.5h old
      },
      {
        id: "audit-2",
        resourceType: "user",
        resourceId: "res-2",
        metadata: { userId: "other-user", wasMember: true },
        createdAt: new Date(now.getTime() - 20 * 60 * 1000), // 20m old
      },
    ]);

    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.reconciled).toBe(2);
    expect(result.olderThan1h).toBe(1);
    expect(result.entries).toEqual([
      { tenantId: TENANT_1, subjectHash: "res-1" },
    ]);
  });

  it("re-enqueues unreconciled tenant purge rows (#1141)", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-tenant-purge",
        resourceType: "tenant",
        resourceId: TENANT_1,
        metadata: {},
        createdAt: new Date(now.getTime() - 90 * 60 * 1000), // 1.5h old
      },
    ]);

    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.reconciled).toBe(1);
    expect(result.olderThan1h).toBe(1);
    expect(result.entries).toEqual([
      { tenantId: TENANT_1, subjectHash: TENANT_1 },
    ]);
    expect(mockEnqueueErasure).toHaveBeenCalledWith(
      { kind: "tenant", tenantId: TENANT_1 },
      {},
    );
    expect(mockCount).toHaveBeenCalledWith(1, { outcome: "reconciled" });
  });

  it("skips re-enqueuing when job is already active or waiting in queue", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-1",
        resourceId: "res-1",
        metadata: { userId: SUBJECT, wasMember: true },
        createdAt: new Date(now.getTime() - 30 * 60 * 1000),
      },
    ]);
    mockGetJob.mockResolvedValueOnce({
      getState: vi.fn().mockResolvedValue("active"),
    });

    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.reconciled).toBe(0);
    expect(mockEnqueueErasure).not.toHaveBeenCalled();
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ state: "active" }),
      "superset-erasure-reconcile: job already in queue and active; skipping re-enqueue",
    );
  });

  it("re-enqueues if existing job in BullMQ had failed or completed", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-1",
        resourceId: "res-1",
        metadata: { userId: SUBJECT, wasMember: true },
        createdAt: new Date(now.getTime() - 30 * 60 * 1000),
      },
    ]);
    mockGetJob.mockResolvedValueOnce({
      getState: vi.fn().mockResolvedValue("failed"),
    });

    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.reconciled).toBe(1);
    expect(mockEnqueueErasure).toHaveBeenCalled();
  });

  it("skips rows with missing or non-string metadata.userId", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-corrupt",
        resourceId: "res-corrupt",
        metadata: { wasMember: true }, // missing userId
        createdAt: new Date(now.getTime() - 30 * 60 * 1000),
      },
    ]);

    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.reconciled).toBe(0);
    expect(mockEnqueueErasure).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ auditId: "audit-corrupt" }),
      expect.stringContaining("has no valid metadata.userId; skipping"),
    );
  });

  it("does not increment reconciled counter if enqueueSupersetErasure returns false", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-1",
        resourceId: "res-1",
        metadata: { userId: SUBJECT, wasMember: true },
        createdAt: new Date(now.getTime() - 30 * 60 * 1000),
      },
    ]);
    mockEnqueueErasure.mockResolvedValueOnce(false);

    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.reconciled).toBe(0);
    expect(mockCount).not.toHaveBeenCalled();
  });
});

describe("scheduleSupersetErasureReconcile & stop", () => {
  it("schedules recurring 5m job and startup job", async () => {
    await scheduleSupersetErasureReconcile();
    expect(mockAddQueue).toHaveBeenCalledWith(
      "reconcile",
      {},
      {
        repeat: { pattern: "*/5 * * * *" },
        jobId: RECONCILE_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    expect(mockAddQueue).toHaveBeenCalledWith(
      "reconcile-on-start",
      {},
      {
        jobId: RECONCILE_START_JOB_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  });

  it("stops worker gracefully", async () => {
    await expect(stopSupersetErasureReconcileWorker()).resolves.toBeUndefined();
  });
});
