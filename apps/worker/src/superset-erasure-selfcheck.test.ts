import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockEnv,
  mockCount,
  mockWrite,
  mockOpen,
  mockErase,
  mockError,
  mockInfo,
  mockQueueAdd,
  mockQueueClose,
  mockGetRepeatable,
  mockRemoveRepeatable,
  mockWorkerClose,
  workerArgs,
  seeded,
  mockRead,
} = vi.hoisted(() => ({
  mockRead: vi.fn(),
  seeded: [] as unknown[][],
  mockQueueAdd: vi.fn(),
  mockQueueClose: vi.fn(),
  mockGetRepeatable: vi.fn(),
  mockRemoveRepeatable: vi.fn(),
  mockWorkerClose: vi.fn(),
  workerArgs: [] as unknown[][],
  mockEnv: {
    SUPERSET_OAUTH_CLIENT_ID: "client-id" as string | undefined,
    SUPERSET_DEPLOYMENT: "on" as "on" | "off",
    SUPERSET_SELFCHECK_INTERVAL_MINUTES: 15,
  },
  mockCount: vi.fn(),
  mockWrite: vi.fn(),
  mockOpen: vi.fn(),
  mockErase: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock("@platform/config", () => ({
  env: mockEnv,
  supersetErasureMode: (e: typeof mockEnv): string =>
    e.SUPERSET_DEPLOYMENT === "off"
      ? "off"
      : e.SUPERSET_OAUTH_CLIENT_ID
        ? "full"
        : "cache-only",
}));
vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), info: mockInfo, error: mockError },
}));
vi.mock("@platform/telemetry", () => ({
  supersetErasureSelfcheckTotal: {
    add: (...args: unknown[]): unknown => {
      if (args[0] === 0) seeded.push(args);
      return mockCount(...args);
    },
  },
  Queue: class {
    add = mockQueueAdd;
    close = mockQueueClose;
    getRepeatableJobs = mockGetRepeatable;
    removeRepeatableByKey = mockRemoveRepeatable;
  },
  Worker: class {
    constructor(...args: unknown[]) {
      workerArgs.push(args);
    }
    on = vi.fn();
    close = mockWorkerClose;
  },
}));
vi.mock("./queues.js", () => ({ connection: { conn: true } }));
vi.mock("@platform/redis", () => ({
  writeSupersetSelfcheck: mockWrite,
  readSupersetSelfcheck: mockRead,
}));
vi.mock("./superset-erasure.js", () => ({
  openSession: mockOpen,
  eraseOnce: mockErase,
  supersetUrl: (p: string) => `http://superset:8088${p}`,
}));

const {
  compareEnablement,
  runSupersetSelfcheck,
  SMOKE_TENANT_ID,
  scheduleSupersetErasureSelfcheck,
  stopSupersetErasureSelfcheck,
  SELFCHECK_QUEUE_NAME,
  SELFCHECK_REPEAT_JOB_ID,
  SELFCHECK_START_JOB_ID,
} = await import("./superset-erasure-selfcheck.js");

const SESSION = { accessToken: "tok", csrfToken: "csrf", cookie: "s=1" };
const NO_OP = {
  matchedUsers: 0,
  heldUsers: 0,
  deletedRows: 0,
  cacheKeysRemoved: 0,
  more: false,
};

function statusReply(stage2: boolean, status = 200, erasure = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          stage2,
          erasure,
          owsubMarker: true,
          version: "6.1.0",
        }),
        { status },
      ),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.SUPERSET_OAUTH_CLIENT_ID = "client-id";
  mockEnv.SUPERSET_DEPLOYMENT = "on";
  mockEnv.SUPERSET_SELFCHECK_INTERVAL_MINUTES = 15;
  mockGetRepeatable.mockResolvedValue([]);
  mockRead.mockResolvedValue(null);
  mockOpen.mockResolvedValue(SESSION);
  mockErase.mockResolvedValue(NO_OP);
  mockWrite.mockResolvedValue(undefined);
  statusReply(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compareEnablement (#1137)", () => {
  it("agrees when both say on, or both say off", () => {
    expect(compareEnablement({ stage2: true }, "full").mismatch).toBe(false);
    expect(compareEnablement({ stage2: false }, "cache-only").mismatch).toBe(
      false,
    );
    expect(compareEnablement({ stage2: false }, "off").mismatch).toBe(false);
  });

  it("flags Superset on while the local mode is cache-only or off", () => {
    for (const local of ["cache-only", "off"] as const) {
      const r = compareEnablement({ stage2: true }, local);
      expect(r.mismatch).toBe(true);
      expect(r.reason).toContain("Superset has Stage 2 on");
    }
  });

  it("flags the local id set while Superset has Stage 2 off", () => {
    const r = compareEnablement({ stage2: false }, "full");
    expect(r.mismatch).toBe(true);
    expect(r.reason).toContain("Superset has Stage 2 off");
  });
});

describe("runSupersetSelfcheck (#1137)", () => {
  it("is ok when both agree and the smoke erase is a no-op, and erases only the synthetic tenant", async () => {
    const r = await runSupersetSelfcheck(() => 1234);
    expect(r).toEqual({
      checkedAt: 1234,
      outcome: "ok",
      stage2: true,
      mismatch: false,
    });
    expect(mockCount).toHaveBeenCalledWith(1, { outcome: "ok" });
    expect(mockWrite).toHaveBeenCalledWith(r);
    const [, job] = mockErase.mock.calls[0] as [
      unknown,
      { kind: string; tenantId: string; subject: string },
    ];
    expect(job).toMatchObject({ kind: "user", tenantId: SMOKE_TENANT_ID });
    expect(job.subject).toMatch(/^smoke-/);
  });

  it("reports a mismatch when Superset has Stage 2 on and this worker does not, and still runs the smoke erase", async () => {
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
    const r = await runSupersetSelfcheck();
    expect(r).toMatchObject({
      outcome: "mismatch",
      stage2: true,
      mismatch: true,
    });
    expect(mockCount).toHaveBeenCalledWith(1, { outcome: "mismatch" });
    expect(mockErase).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalled();
  });

  it("reports a mismatch in the harmless direction too", async () => {
    statusReply(false);
    const r = await runSupersetSelfcheck();
    expect(r).toMatchObject({
      outcome: "mismatch",
      stage2: false,
      mismatch: true,
    });
  });

  it("is smoke_failed, keeping the mismatch flag, when the smoke erase fails", async () => {
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
    mockErase.mockRejectedValue(
      new Error("Superset erase call failed with 403"),
    );
    const r = await runSupersetSelfcheck();
    expect(r).toMatchObject({
      outcome: "smoke_failed",
      stage2: true,
      mismatch: true,
    });
  });

  it("is smoke_failed when the smoke erase matches someone or deletes anything", async () => {
    for (const reply of [
      { ...NO_OP, matchedUsers: 1 },
      { ...NO_OP, heldUsers: 1 },
      { ...NO_OP, deletedRows: 3 },
      { ...NO_OP, more: true },
    ]) {
      mockErase.mockResolvedValue(reply);
      expect((await runSupersetSelfcheck()).outcome).toBe("smoke_failed");
    }
  });

  it("is smoke_failed when the status route is missing, refused or malformed, and does not erase", async () => {
    statusReply(true, 404);
    expect((await runSupersetSelfcheck()).outcome).toBe("smoke_failed");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ stage2: "yes" }))),
    );
    expect((await runSupersetSelfcheck()).outcome).toBe("smoke_failed");
    expect(mockErase).not.toHaveBeenCalled();
  });

  it("is smoke_failed when Superset says erasure is not available", async () => {
    statusReply(true, 200, false);
    expect((await runSupersetSelfcheck()).outcome).toBe("smoke_failed");
    expect(mockErase).not.toHaveBeenCalled();
  });

  it("is unreachable when no session can be opened and erasure is on", async () => {
    mockOpen.mockRejectedValue(new Error("fetch failed"));
    for (const id of ["client-id", undefined]) {
      mockEnv.SUPERSET_OAUTH_CLIENT_ID = id;
      const r = await runSupersetSelfcheck();
      expect(r).toMatchObject({
        outcome: "unreachable",
        stage2: null,
        mismatch: false,
      });
    }
  });

  it("is skipped, not an alarm, when Superset is unreachable and erasure is turned off", async () => {
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
    mockEnv.SUPERSET_DEPLOYMENT = "off";
    mockOpen.mockRejectedValue(new Error("fetch failed"));
    const r = await runSupersetSelfcheck();
    expect(r).toMatchObject({
      outcome: "skipped",
      stage2: null,
      mismatch: false,
    });
    expect(mockCount).toHaveBeenCalledWith(1, { outcome: "skipped" });
  });

  it("still reports when the result cannot be stored", async () => {
    mockWrite.mockRejectedValue(new Error("redis down"));
    await expect(runSupersetSelfcheck()).resolves.toMatchObject({
      outcome: "ok",
    });
    expect(mockError).toHaveBeenCalled();
  });

  it("with the flag off and Superset reachable but Stage 2 off, is skipped and runs no smoke erase", async () => {
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
    mockEnv.SUPERSET_DEPLOYMENT = "off";
    statusReply(false);
    expect(await runSupersetSelfcheck()).toMatchObject({
      outcome: "skipped",
      stage2: false,
      mismatch: false,
    });
    expect(mockErase).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it("with the flag off, a failing status route is skipped, not an alarm", async () => {
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
    mockEnv.SUPERSET_DEPLOYMENT = "off";
    statusReply(false, 404);
    expect(await runSupersetSelfcheck()).toMatchObject({
      outcome: "skipped",
      stage2: null,
    });
    expect(mockError).not.toHaveBeenCalled();
  });

  it("with the flag off, keeps a last known Stage 2 on alive as unreachable when Superset cannot be asked", async () => {
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
    mockEnv.SUPERSET_DEPLOYMENT = "off";
    mockRead.mockResolvedValue({
      checkedAt: 1,
      outcome: "mismatch",
      stage2: true,
      mismatch: true,
    });
    mockOpen.mockRejectedValue(new Error("fetch failed"));
    expect(await runSupersetSelfcheck()).toMatchObject({
      outcome: "unreachable",
      stage2: true,
      mismatch: true,
    });
    mockOpen.mockResolvedValue(SESSION);
    statusReply(false, 503);
    expect(await runSupersetSelfcheck()).toMatchObject({
      outcome: "unreachable",
      stage2: true,
    });
  });

  it("with the flag off but Superset reporting Stage 2 on, is a mismatch (safety net) with stage2 recorded", async () => {
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
    mockEnv.SUPERSET_DEPLOYMENT = "off";
    statusReply(true);
    const r = await runSupersetSelfcheck();
    expect(r).toMatchObject({
      outcome: "mismatch",
      stage2: true,
      mismatch: true,
    });
    expect(mockWrite).toHaveBeenCalledWith(r);
    expect(mockError).toHaveBeenCalled();
  });
});

describe("scheduling (#1137: one repeatable job, however many workers)", () => {
  it("builds its worker on its own queue with the shared connection", () => {
    expect(workerArgs).toHaveLength(1);
    expect(workerArgs[0]?.[0]).toBe(SELFCHECK_QUEUE_NAME);
    expect(workerArgs[0]?.[2]).toEqual({ connection: { conn: true } });
  });

  it("starts every outcome at zero at import, so the first one still moves increase()", () => {
    for (const outcome of [
      "ok",
      "mismatch",
      "smoke_failed",
      "unreachable",
      "skipped",
    ]) {
      expect(seeded).toContainEqual([0, { outcome }]);
    }
  });

  it("registers a repeatable job with a fixed id every interval, plus one run at start", async () => {
    await scheduleSupersetErasureSelfcheck();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "check",
      {},
      {
        repeat: { every: 15 * 60_000 },
        jobId: SELFCHECK_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "check-on-start",
      {},
      {
        jobId: SELFCHECK_START_JOB_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    expect(mockRemoveRepeatable).not.toHaveBeenCalled();
    expect(mockQueueClose).toHaveBeenCalledTimes(1);
  });

  it("takes the interval from SUPERSET_SELFCHECK_INTERVAL_MINUTES", async () => {
    mockEnv.SUPERSET_SELFCHECK_INTERVAL_MINUTES = 5;
    await scheduleSupersetErasureSelfcheck();
    expect(mockQueueAdd.mock.calls[0]?.[2]).toMatchObject({
      repeat: { every: 300_000 },
    });
  });

  it("removes a repeatable left by an earlier interval, and keeps the current one", async () => {
    mockGetRepeatable.mockResolvedValue([
      { name: "check", key: "old", every: "600000" },
      { name: "check", key: "same", every: String(15 * 60_000) },
      { name: "other", key: "unrelated", every: "1" },
    ]);
    await scheduleSupersetErasureSelfcheck();
    expect(mockRemoveRepeatable).toHaveBeenCalledTimes(1);
    expect(mockRemoveRepeatable).toHaveBeenCalledWith("old");
  });

  it("closes its queue handle even when registration fails", async () => {
    mockQueueAdd.mockRejectedValueOnce(new Error("redis down"));
    await expect(scheduleSupersetErasureSelfcheck()).rejects.toThrow();
    expect(mockQueueClose).toHaveBeenCalledTimes(1);
  });

  it("closes its worker on shutdown", async () => {
    await stopSupersetErasureSelfcheck();
    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
  });
});
