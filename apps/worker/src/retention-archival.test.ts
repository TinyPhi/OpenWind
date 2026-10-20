import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as ConfigModule from "@platform/config";

// mock bullmq
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    _processor: () => Promise<void>,
  ) {
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// mock db
const mockWhereSelect = vi.fn();
vi.mock("@platform/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: mockWhereSelect }) }),
  },
  tenants: {
    id: "tenants.id",
    config: "tenants.config",
    status: "tenants.status",
  },
}));

const mockSweepTenant = vi.fn();
vi.mock("./retention-sweep.js", () => ({
  sweepTenant: (...args: unknown[]) => mockSweepTenant(...args),
}));

vi.mock("./queues.js", () => ({ connection: {} }));

vi.mock("@platform/config", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return { ...actual, env: { ...actual.env, USER_EXPORT_TTL_DAYS: 7 } };
});
const mockDeleteExpiredUserExports = vi.fn();
vi.mock("@platform/files", () => ({
  deleteExpiredUserDataExports: (...args: unknown[]) =>
    mockDeleteExpiredUserExports(...args),
}));

vi.mock("@platform/auth", () => ({
  isTenantTrialActive: (trialEndsAt: number | null) =>
    trialEndsAt === null || trialEndsAt > Date.now(),
}));

// mock redis
const mockRedisSet = vi.fn().mockResolvedValue("OK");
const mockRedisEval = vi.fn().mockResolvedValue(1);
vi.mock("@platform/redis", () => ({
  getRedis: () => ({
    set: mockRedisSet,
    eval: mockRedisEval,
  }),
}));

const { runRetentionArchivalSweep } = await import("./retention-archival.js");

describe("Retention Archival Sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSweepTenant.mockResolvedValue({});
    mockDeleteExpiredUserExports.mockResolvedValue(0);
  });

  it("deletes expired user-data export files even for a tenant under hold", async () => {
    mockWhereSelect.mockResolvedValueOnce([
      { id: "held", config: { retention_hold: true }, trialEndsAt: null },
    ]);

    await runRetentionArchivalSweep();

    expect(mockDeleteExpiredUserExports).toHaveBeenCalledWith(
      "held",
      7 * 86_400_000,
    );
    expect(mockSweepTenant).not.toHaveBeenCalled();
  });

  it("still sweeps the tenant when the export-file deletion fails", async () => {
    mockWhereSelect.mockResolvedValueOnce([
      { id: "t1", config: {}, trialEndsAt: null },
    ]);
    mockDeleteExpiredUserExports.mockRejectedValueOnce(new Error("disk"));

    await runRetentionArchivalSweep();

    expect(mockSweepTenant).toHaveBeenCalledTimes(1);
  });

  it("sweeps each active tenant with its resolved policy", async () => {
    mockWhereSelect.mockResolvedValueOnce([
      { id: "tenant-1", config: { retention_days: 30 }, trialEndsAt: null },
      { id: "tenant-2", config: {}, trialEndsAt: null },
    ]);

    await runRetentionArchivalSweep();

    expect(mockSweepTenant).toHaveBeenCalledTimes(2);
    expect(mockSweepTenant.mock.calls[0]?.[1]).toMatchObject({ noiseDays: 30 });
    expect(mockSweepTenant.mock.calls[1]?.[1]).toMatchObject({ noiseDays: 90 });
  });

  it("skips tenants under retention hold and expired trials", async () => {
    mockWhereSelect.mockResolvedValueOnce([
      { id: "held", config: { retention_hold: true }, trialEndsAt: null },
      { id: "expired", config: {}, trialEndsAt: new Date(Date.now() - 1000) },
    ]);

    await runRetentionArchivalSweep();

    expect(mockSweepTenant).not.toHaveBeenCalled();
  });

  it("keeps sweeping other tenants when one fails", async () => {
    mockWhereSelect.mockResolvedValueOnce([
      { id: "bad", config: {}, trialEndsAt: null },
      { id: "good", config: {}, trialEndsAt: null },
    ]);
    mockSweepTenant.mockRejectedValueOnce(new Error("boom"));

    await runRetentionArchivalSweep();

    expect(mockSweepTenant).toHaveBeenCalledTimes(2);
  });

  it("releases the sweep lock only with the token it acquired it with", async () => {
    mockWhereSelect.mockResolvedValueOnce([]);

    await runRetentionArchivalSweep();

    const token = mockRedisSet.mock.calls[0]?.[1];
    expect(token).not.toBe("locked");
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    expect(mockRedisEval.mock.calls[0]?.slice(1)).toEqual([
      1,
      "lock:retention-archival-sweep",
      token,
    ]);
  });

  it("does not sweep or release when another instance holds the lock", async () => {
    mockRedisSet.mockResolvedValueOnce(null);

    await runRetentionArchivalSweep();

    expect(mockSweepTenant).not.toHaveBeenCalled();
    expect(mockRedisEval).not.toHaveBeenCalled();
  });
});
