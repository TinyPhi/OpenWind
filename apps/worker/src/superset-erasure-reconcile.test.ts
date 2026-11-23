import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  mockWriteUnreconciled,
  mockReadEntries,
  mockReadCount,
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
    mockWriteUnreconciled: vi.fn(),
    mockReadEntries: vi.fn(),
    mockReadCount: vi.fn(),
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
  writeSupersetUnreconciled: mockWriteUnreconciled,
  readSupersetUnreconciledEntries: mockReadEntries,
  readSupersetUnreconciledCount: mockReadCount,
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
  BATCH_LIMIT,
  MONITOR_WINDOW_DAYS,
} = await import("./superset-erasure-reconcile.js");

const TENANT_1 = "aaaaaaaa-1111-4000-a000-000000000001";
const TENANT_2 = "bbbbbbbb-2222-4000-b000-000000000002";
const SUBJECT = "393014043322875906";

/**
 * The sweep reads twice per tenant: retryable rows first, then terminally failed ones. A row's
 * `terminalFailed` flag decides which read returns it.
 */
function mockDbRows(rows: { terminalFailed?: boolean }[]) {
  let call = 0;
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      const wantTerminal = call % 2 === 1;
      call += 1;
      return Promise.resolve(
        rows.filter((r) => Boolean(r.terminalFailed) === wantTerminal),
      );
    }),
  };
  mockTxSelect.mockReturnValue(chain);
  return chain;
}

afterEach(() => {
  vi.useRealTimers();
});

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
  mockWriteUnreconciled.mockResolvedValue(undefined);
  mockReadEntries.mockResolvedValue(null);
  mockReadCount.mockResolvedValue(null);
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
    expect(mockWriteUnreconciled).toHaveBeenCalledWith(0, []);
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
    expect(mockWriteUnreconciled).toHaveBeenCalledWith(0, []);
  });

  it("sweeps active tenants when mode is full and writes total older than 1h to Redis", async () => {
    const now = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
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
    const createdAt = now.getTime() - 2 * 60 * 60 * 1000;
    expect(mockWriteUnreconciled).toHaveBeenCalledWith(2, [
      { tenantId: TENANT_1, subjectHash: "res-1", createdAt },
      { tenantId: TENANT_2, subjectHash: "res-1", createdAt },
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
      {
        tenantId: TENANT_1,
        subjectHash: "res-1",
        createdAt: now.getTime() - 90 * 60 * 1000,
      },
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
      {
        tenantId: TENANT_1,
        subjectHash: TENANT_1,
        createdAt: now.getTime() - 90 * 60 * 1000,
      },
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

describe("monitoring what stays open (#1141)", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it("reads retryable and terminally failed rows separately, oldest first, with a batch limit each", async () => {
    const chain = mockDbRows([]);
    await reconcileTenantSupersetErasure(TENANT_1, new Date());
    expect(chain.orderBy).toHaveBeenCalledTimes(2);
    expect(chain.limit).toHaveBeenCalledTimes(2);
    expect(chain.limit).toHaveBeenNthCalledWith(1, BATCH_LIMIT);
    expect(chain.limit).toHaveBeenNthCalledWith(2, BATCH_LIMIT);
    expect(MONITOR_WINDOW_DAYS).toBe(90);
  });

  it("warns when the batch limit is reached, for either kind of row", async () => {
    const now = new Date();
    const rowsOf = (terminalFailed: boolean) =>
      Array.from({ length: 3 }, (_, i) => ({
        id: `a${i}`,
        resourceType: "user",
        resourceId: `res-${terminalFailed}-${i}`,
        metadata: { userId: `u${i}`, wasMember: true },
        createdAt: new Date(now.getTime() - 2 * HOUR),
        terminalFailed,
      }));
    mockDbRows([...rowsOf(false), ...rowsOf(true)]);

    const result = await reconcileTenantSupersetErasure(TENANT_1, now, {
      batchLimit: 3,
    });

    expect(result.olderThan1h).toBe(6);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "retryable", batchLimit: 3 }),
      expect.stringContaining("batch limit reached"),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminally failed", batchLimit: 3 }),
      expect.stringContaining("batch limit reached"),
    );
  });

  it("keeps a row past the 30-day target in the entries, with its original created_at", async () => {
    const now = new Date();
    const created = new Date(now.getTime() - 45 * DAY);
    mockDbRows([
      {
        id: "audit-old",
        resourceType: "user",
        resourceId: "res-old",
        metadata: { userId: SUBJECT, wasMember: true },
        createdAt: created,
        terminalFailed: false,
      },
    ]);

    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.entries).toEqual([
      {
        tenantId: TENANT_1,
        subjectHash: "res-old",
        createdAt: created.getTime(),
      },
    ]);
    expect(result.reconciled).toBe(1);
  });

  it("keeps a terminally failed row in the entries but does not re-enqueue it", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-failed",
        resourceType: "user",
        resourceId: "res-failed",
        metadata: { userId: SUBJECT, wasMember: true },
        createdAt: new Date(now.getTime() - 3 * DAY),
        terminalFailed: true,
      },
      {
        id: "audit-failed-tenant",
        resourceType: "tenant",
        resourceId: TENANT_1,
        metadata: {},
        createdAt: new Date(now.getTime() - 4 * DAY),
        terminalFailed: true,
      },
    ]);

    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.olderThan1h).toBe(2);
    expect(result.entries.map((e) => e.subjectHash)).toEqual([
      TENANT_1,
      "res-failed",
    ]);
    expect(result.reconciled).toBe(0);
    expect(mockEnqueueErasure).not.toHaveBeenCalled();
    expect(mockGetJob).not.toHaveBeenCalled();
  });

  it("does not list a row younger than an hour, which is still in flight", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-young",
        resourceType: "user",
        resourceId: "res-young",
        metadata: { userId: SUBJECT, wasMember: true },
        createdAt: new Date(now.getTime() - 10 * 60 * 1000),
        terminalFailed: false,
      },
    ]);
    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.entries).toEqual([]);
    expect(result.olderThan1h).toBe(0);
    expect(result.reconciled).toBe(1);
  });

  it("skips a tenant purge job that is already active or waiting", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-tenant",
        resourceType: "tenant",
        resourceId: TENANT_1,
        metadata: {},
        createdAt: new Date(now.getTime() - 2 * HOUR),
        terminalFailed: false,
      },
    ]);
    mockGetJob.mockResolvedValueOnce({
      getState: vi.fn().mockResolvedValue("waiting"),
    });

    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.reconciled).toBe(0);
    expect(result.olderThan1h).toBe(1);
    expect(mockEnqueueErasure).not.toHaveBeenCalled();
  });

  it("re-enqueues a tenant purge job whose previous run failed, and passes force when overridden", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-tenant",
        resourceType: "tenant",
        resourceId: TENANT_1,
        metadata: {},
        createdAt: new Date(now.getTime() - 2 * HOUR),
        terminalFailed: false,
      },
    ]);
    mockGetJob.mockResolvedValueOnce({
      getState: vi.fn().mockResolvedValue("failed"),
    });

    const result = await reconcileTenantSupersetErasure(TENANT_1, now, {
      force: true,
    });
    expect(result.reconciled).toBe(1);
    expect(mockEnqueueErasure).toHaveBeenCalledWith(
      { kind: "tenant", tenantId: TENANT_1 },
      { force: true },
    );
  });

  it("does not count a tenant purge as reconciled when enqueue returns false", async () => {
    const now = new Date();
    mockDbRows([
      {
        id: "audit-tenant",
        resourceType: "tenant",
        resourceId: TENANT_1,
        metadata: {},
        createdAt: new Date(now.getTime() - 2 * HOUR),
        terminalFailed: false,
      },
    ]);
    mockEnqueueErasure.mockResolvedValueOnce(false);

    const result = await reconcileTenantSupersetErasure(TENANT_1, now);
    expect(result.reconciled).toBe(0);
    expect(mockCount).not.toHaveBeenCalled();
  });
});

describe("a sweep with a failed tenant (#1141)", () => {
  const created = 1_700_000_000_000;

  function failTenant2() {
    mockForEachTenant.mockImplementation(
      async (
        _sweep: string,
        tenantIds: string[],
        fn: (id: string) => Promise<unknown>,
      ) => {
        const results = new Map();
        const failedTenantIds: string[] = [];
        for (const id of tenantIds) {
          if (id === TENANT_2) failedTenantIds.push(id);
          else results.set(id, await fn(id));
        }
        return { results, failedTenantIds };
      },
    );
  }

  it("keeps the failed tenant's previous entries and counts them", async () => {
    failTenant2();
    mockReadEntries.mockResolvedValue([
      { tenantId: TENANT_2, subjectHash: "kept-1", createdAt: created },
      { tenantId: TENANT_2, subjectHash: "kept-2", createdAt: created + 1 },
      { tenantId: TENANT_1, subjectHash: "other", createdAt: created },
    ]);
    mockDbRows([]);

    await runSupersetErasureReconcile();

    expect(mockWriteUnreconciled).toHaveBeenCalledWith(2, [
      { tenantId: TENANT_2, subjectHash: "kept-1", createdAt: created },
      { tenantId: TENANT_2, subjectHash: "kept-2", createdAt: created + 1 },
    ]);
  });

  it("never publishes a count below the previous one while a tenant is failing (the stored list is capped)", async () => {
    failTenant2();
    mockReadEntries.mockResolvedValue([
      { tenantId: TENANT_2, subjectHash: "kept-1", createdAt: created },
    ]);
    mockReadCount.mockResolvedValue(450);
    mockDbRows([]);

    await runSupersetErasureReconcile();

    expect(mockWriteUnreconciled).toHaveBeenCalledWith(450, [
      { tenantId: TENANT_2, subjectHash: "kept-1", createdAt: created },
    ]);
  });

  it("publishes nothing when a tenant failed and there is no previous snapshot to carry", async () => {
    failTenant2();
    mockReadEntries.mockResolvedValue(null);
    mockDbRows([]);

    const summary = await runSupersetErasureReconcile();

    expect(mockWriteUnreconciled).not.toHaveBeenCalled();
    expect(summary.failedTenantCount).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failedTenants: 1 }),
      expect.stringContaining("no previous snapshot"),
    );
  });

  it("does not read the previous snapshot when every tenant was swept", async () => {
    mockDbRows([]);
    await runSupersetErasureReconcile();
    expect(mockReadEntries).not.toHaveBeenCalled();
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
