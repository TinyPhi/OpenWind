import { describe, it, expect, vi, beforeEach } from "vitest";

// mock platform config
vi.mock("@platform/config", () => ({
  env: {
    NODE_ENV: "test",
  },
  PLAN_LIMITS: {
    standard: {
      apiCallsPerDay: 10_000,
      storageBytes: 10 * 1024 * 1024 * 1024,
      aiTokensPerDay: 50_000,
    },
    premium: {
      apiCallsPerDay: 100_000,
      storageBytes: 100 * 1024 * 1024 * 1024,
      aiTokensPerDay: 500_000,
    },
    enterprise: {
      apiCallsPerDay: 1_000_000,
      storageBytes: 1000 * 1024 * 1024 * 1024,
      aiTokensPerDay: 5_000_000,
    },
  },
}));

// mock bullmq
let capturedProcessor: (() => Promise<void>) | undefined;
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: () => Promise<void>,
  ) {
    capturedProcessor = processor;
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockInsert = vi.fn();

mockSelect.mockImplementation(() => ({
  from: mockFrom.mockImplementation(() => ({
    where: mockWhere,
  })),
}));

mockInsert.mockImplementation(() => ({
  values: vi.fn().mockImplementation(() => ({
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@platform/db", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
  },
  tenants: { id: "tenants.id", plan: "tenants.plan", status: "tenants.status" },
  tenantUsageDaily: {
    tenantId: "tenant_usage_daily.tenant_id",
    usageDate: "tenant_usage_daily.usage_date",
    metric: "tenant_usage_daily.metric",
    value: "tenant_usage_daily.value",
  },
}));

// mock redis
const mockGet = vi.fn();
const mockSmembers = vi.fn().mockResolvedValue([]);
const mockDel = vi.fn();
const mockSadd = vi.fn();
const mockSet = vi.fn().mockResolvedValue("OK");

vi.mock("@platform/redis", () => ({
  getRedis: () => ({
    get: mockGet,
    smembers: mockSmembers,
    del: mockDel,
    sadd: mockSadd,
    set: mockSet,
  }),
}));

// mock files
const mockGetTenantUsedBytes = vi.fn();
vi.mock("@platform/files", () => ({
  getTenantUsedBytes: (...args: unknown[]) => mockGetTenantUsedBytes(...args),
}));

// mock auth
const mockListUserIdsWithRole = vi.fn();
vi.mock("@platform/auth", () => ({
  listUserIdsWithRole: (...args: unknown[]) => mockListUserIdsWithRole(...args),
}));

// mock notifications
const mockSendNotification = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/notifications", () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}));

vi.mock("./queues.js", () => ({ connection: {} }));

const { runUsageMeteringSweep } = await import("./usage-metering.js");

describe("runUsageMeteringSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes active tenants, checks limits, flushes to DB, and triggers notifications", async () => {
    // Mock active tenants
    mockWhere.mockResolvedValueOnce([
      { id: "tenant-1", plan: "standard" },
      { id: "tenant-2", plan: "standard" },
    ]);

    // Mock storage bytes
    mockGetTenantUsedBytes
      .mockResolvedValueOnce(5_000_000) // tenant-1: 5MB (within 10GB limit)
      .mockResolvedValueOnce(20 * 1024 * 1024 * 1024); // tenant-2: 20GB (exceeds 10GB limit)

    // Mock yesterday's Redis counters
    mockGet
      .mockResolvedValueOnce("8000") // tenant-1 api (yesterday)
      .mockResolvedValueOnce("1000") // tenant-1 ai (yesterday)
      .mockResolvedValueOnce("15000") // tenant-2 api (yesterday)
      .mockResolvedValueOnce("20000"); // tenant-2 ai (yesterday)

    // Mock today's running Redis counters
    mockGet
      .mockResolvedValueOnce("9000") // tenant-1 api (today)
      .mockResolvedValueOnce("2000") // tenant-1 ai (today)
      .mockResolvedValueOnce("12000") // tenant-2 api (today, exceeds 10,000 limit)
      .mockResolvedValueOnce("55000"); // tenant-2 ai (today, exceeds 50,000 limit)

    // Mock tenant admins list
    mockListUserIdsWithRole
      .mockResolvedValueOnce(["admin-1"]) // tenant-1
      .mockResolvedValueOnce(["admin-2"]); // tenant-2

    await runUsageMeteringSweep();

    // Verify DB inserts occurred for both tenants (both yesterday and today)
    expect(mockInsert).toHaveBeenCalledTimes(4);

    // Verify tenant-1 was NOT flagged as degraded in Redis (limits not exceeded)
    expect(mockDel).toHaveBeenCalledWith("degraded:tenant-1");

    // Verify tenant-2 was flagged as degraded on api_calls, storage, and ai_tokens
    expect(mockDel).toHaveBeenCalledWith("degraded:tenant-2");
    expect(mockSadd).toHaveBeenCalledWith(
      "degraded:tenant-2",
      "api_calls",
      "storage",
      "ai_tokens",
    );

    // Verify notification was sent for tenant-2 (which transition into degraded)
    expect(mockSendNotification).toHaveBeenCalledTimes(4);
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-2",
      "admin-2",
      "tenant.plan_degraded",
      expect.objectContaining({
        metric: "api_calls",
        plan: "standard",
      }),
    );
  });

  it("sends plan_recovered notification when tenant exits degraded state", async () => {
    mockWhere.mockResolvedValueOnce([{ id: "tenant-3", plan: "standard" }]);
    mockGetTenantUsedBytes.mockResolvedValueOnce(1_000_000); // 1MB
    mockGet.mockResolvedValue("0"); // API & AI all 0

    // Previously degraded on storage
    mockSmembers.mockResolvedValueOnce(["storage"]);

    mockListUserIdsWithRole.mockResolvedValueOnce(["admin-3"]);

    await runUsageMeteringSweep();

    // Verify degradation set cleared
    expect(mockDel).toHaveBeenCalledWith("degraded:tenant-3");

    // Verify recovered notification dispatched
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-3",
      "admin-3",
      "tenant.plan_recovered",
      expect.objectContaining({
        metric: "storage",
        plan: "standard",
      }),
    );
  });

  it("triggers processor from worker", async () => {
    mockWhere.mockResolvedValueOnce([]);
    expect(capturedProcessor).toBeDefined();

    await capturedProcessor!();

    expect(mockSelect).toHaveBeenCalled();
  });
});
