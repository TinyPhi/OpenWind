import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mockTransaction, mockInfo, mockPlanWindows, mockWithTenantContext } =
  vi.hoisted(() => ({
    mockTransaction: vi.fn(),
    mockInfo: vi.fn(),
    mockPlanWindows: vi.fn(),
    mockWithTenantContext: vi.fn(),
  }));

vi.mock("@platform/db", () => ({
  db: { transaction: (...args: unknown[]) => mockTransaction(...args) },
  withTenantContext: (...args: unknown[]) => mockWithTenantContext(...args),
  setOncallRotationSweeperRole: vi.fn(),
  onCallRotations: {},
  onCallSchedules: {},
  onCallScheduleNotices: {},
  notifications: {},
  notificationRecipients: {},
  teams: {},
  tenantSettings: {
    tenantId: "tenant_id",
    defaultTimezone: "default_timezone",
  },
  isOutboundNotificationsEnabled: () => Promise.resolve(false),
}));
vi.mock("@platform/teams", () => ({
  planWindows: (...args: unknown[]) => mockPlanWindows(...args),
  loadTeamMemberIds: () => Promise.resolve(["u-1", "u-2"]),
  loadPreviousHolders: () => Promise.resolve({ primary: "u-1", backup: "u-2" }),
  ROTATION_NOTICE_LEAD_MS: 2 * 24 * 60 * 60 * 1000,
}));
vi.mock("@platform/audit", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("@platform/config", () => ({
  env: { ONCALL_ROTATION_TICK_INTERVAL_SECONDS: 300 },
}));
vi.mock("@platform/logger", () => ({
  logger: { info: mockInfo, warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@platform/redis", () => ({
  getRedis: vi.fn(),
  NOTIFICATION_PUSH_CHANNEL: "notification:push",
}));
vi.mock("./queues.js", () => ({ notifyOutboundQueue: { add: vi.fn() } }));
vi.mock("./tenant-guard.js", () => ({
  validateActiveTenant: () => Promise.resolve(true),
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  exists: vi.fn(),
  gt: vi.fn(),
  isNotNull: vi.fn(),
  isNull: vi.fn(),
  lt: vi.fn(),
  lte: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}));

const {
  startOncallRotationWorker,
  stopOncallRotationWorker,
  generateForRotation,
} = await import("./oncall-rotation-worker.js");

describe("oncall rotation worker lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockTransaction.mockReset();
    mockTransaction.mockResolvedValue([]);
    mockInfo.mockClear();
  });

  afterEach(async () => {
    await stopOncallRotationWorker();
    vi.useRealTimers();
  });

  it("ticks once on start and again every interval", async () => {
    startOncallRotationWorker(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockTransaction).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockTransaction).toHaveBeenCalledTimes(3);
  });

  it("does not start a second timer when started twice", async () => {
    startOncallRotationWorker(1000);
    startOncallRotationWorker(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("skips an interval while the previous tick is still running", async () => {
    let release: (v: unknown[]) => void = () => undefined;
    mockTransaction.mockImplementationOnce(
      () => new Promise<unknown[]>((r) => (release = r)),
    );
    startOncallRotationWorker(1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    release([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockTransaction).toHaveBeenCalledTimes(2);
  });

  it("stops ticking after stop", async () => {
    startOncallRotationWorker(1000);
    await vi.advanceTimersByTimeAsync(0);
    await stopOncallRotationWorker();
    mockTransaction.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("survives a failing discovery query and keeps ticking", async () => {
    mockTransaction.mockRejectedValueOnce(new Error("db down"));
    startOncallRotationWorker(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockTransaction).toHaveBeenCalledTimes(2);
  });
});

describe("generateForRotation tenant timezone (#1162)", () => {
  it("passes tenant default timezone to planWindows", async () => {
    mockPlanWindows.mockReturnValue({
      windows: [],
      skippedEnded: 0,
      capped: false,
      stoppedBy: null,
      cursor: { nextStartsAt: new Date() },
    });
    mockWithTenantContext.mockImplementation(
      async (
        _tenantId: string,
        fn: (tx: Record<string, unknown>) => unknown,
      ) => {
        let fromTable = "";
        const makeLimit = (data: unknown[]) =>
          Object.assign(Promise.resolve(data), {
            for: () => Promise.resolve(data),
          });

        const tx = {
          select: () => tx,
          from: (table: { defaultTimezone?: string }) => {
            fromTable = table?.defaultTimezone ? "settings" : "other";
            return tx;
          },
          where: () => tx,
          update: () => tx,
          set: () => tx,
          limit: () =>
            makeLimit(
              fromTable === "settings"
                ? [{ defaultTimezone: "America/Chicago" }]
                : [
                    {
                      id: "rot-1",
                      teamId: "team-1",
                      status: "active",
                      cycleDays: 7,
                      nextStartsAt: new Date(Date.now() - 1000),
                    },
                  ],
            ),
        };
        return fn(tx);
      },
    );

    await generateForRotation("t-1", "rot-1", new Date());
    expect(mockPlanWindows).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: "America/Chicago" }),
    );
  });

  it("passes null timeZone when tenant has no settings row (fallback to UTC)", async () => {
    mockPlanWindows.mockReturnValue({
      windows: [],
      skippedEnded: 0,
      capped: false,
      stoppedBy: null,
      cursor: { nextStartsAt: new Date() },
    });
    mockWithTenantContext.mockImplementation(
      async (
        _tenantId: string,
        fn: (tx: Record<string, unknown>) => unknown,
      ) => {
        let fromTable = "";
        const makeLimit = (data: unknown[]) =>
          Object.assign(Promise.resolve(data), {
            for: () => Promise.resolve(data),
          });

        const tx = {
          select: () => tx,
          from: (table: { defaultTimezone?: string }) => {
            fromTable = table?.defaultTimezone ? "settings" : "other";
            return tx;
          },
          where: () => tx,
          update: () => tx,
          set: () => tx,
          limit: () =>
            makeLimit(
              fromTable === "settings"
                ? []
                : [
                    {
                      id: "rot-1",
                      teamId: "team-1",
                      status: "active",
                      cycleDays: 7,
                      nextStartsAt: new Date(Date.now() - 1000),
                    },
                  ],
            ),
        };
        return fn(tx);
      },
    );

    await generateForRotation("t-1", "rot-1", new Date());
    expect(mockPlanWindows).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: null }),
    );
  });
});
