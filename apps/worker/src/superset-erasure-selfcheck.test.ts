import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockEnv,
  mockCount,
  mockWrite,
  mockOpen,
  mockErase,
  mockError,
  mockInfo,
} = vi.hoisted(() => ({
  mockEnv: {
    SUPERSET_OAUTH_CLIENT_ID: "client-id" as string | undefined,
    SUPERSET_ERASURE_ENABLED: true,
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
    e.SUPERSET_OAUTH_CLIENT_ID
      ? "full"
      : e.SUPERSET_ERASURE_ENABLED
        ? "cache-only"
        : "off",
}));
vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), info: mockInfo, error: mockError },
}));
vi.mock("@platform/telemetry", () => ({
  supersetErasureSelfcheckTotal: { add: mockCount },
}));
vi.mock("@platform/redis", () => ({ writeSupersetSelfcheck: mockWrite }));
vi.mock("./superset-erasure.js", () => ({
  openSession: mockOpen,
  eraseOnce: mockErase,
  supersetUrl: (p: string) => `http://superset:8088${p}`,
}));

const {
  compareEnablement,
  runSupersetSelfcheck,
  SMOKE_TENANT_ID,
  startSupersetErasureSelfcheck,
  stopSupersetErasureSelfcheck,
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
  mockEnv.SUPERSET_ERASURE_ENABLED = true;
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
    mockEnv.SUPERSET_ERASURE_ENABLED = false;
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

  it("starts with every outcome at zero and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      startSupersetErasureSelfcheck();
      for (const outcome of [
        "ok",
        "mismatch",
        "smoke_failed",
        "unreachable",
        "skipped",
      ]) {
        expect(mockCount).toHaveBeenCalledWith(0, { outcome });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(mockOpen).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(mockOpen).toHaveBeenCalledTimes(2);
    } finally {
      stopSupersetErasureSelfcheck();
      vi.useRealTimers();
    }
  });
});
