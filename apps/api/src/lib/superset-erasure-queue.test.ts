import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockAdd,
  mockGetJob,
  mockInfo,
  mockWarn,
  mockError,
  mockEnv,
  mockCount,
  initialCounts,
} = vi.hoisted(() => ({
  mockCount: vi.fn(),
  initialCounts: [] as unknown[][],
  mockAdd: vi.fn(),
  mockGetJob: vi.fn(),
  mockInfo: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockEnv: {
    SUPERSET_OAUTH_CLIENT_ID: "client-id" as string | undefined,
    SUPERSET_ERASURE_ENABLED: true,
    SUPERSET_REDIS_URL: "redis://superset-cache:6379/1" as string | undefined,
  },
}));
vi.mock("@platform/telemetry", () => ({
  Queue: class {
    add = mockAdd;
    getJob = mockGetJob;
  },
  supersetErasureTotal: {
    add: (...args: unknown[]): unknown => {
      initialCounts.push(args);
      return mockCount(...args);
    },
  },
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
  logger: { error: mockError, warn: mockWarn, info: mockInfo },
}));
vi.mock("@platform/audit", () => ({
  // Stand-in for the real uuid hash: never contains the id, and never a colon.
  auditResourceId: (id: string) =>
    `res-${[...id]
      .reverse()
      .join("")
      .replace(/[^A-Za-z0-9]/g, "_")}`,
}));
vi.mock("./redis.js", () => ({ connection: {} }));

const { enqueueSupersetErasure, eraseUserInSuperset } =
  await import("./superset-erasure-queue.js");

const TENANT = "bbbbbbbb-0002-4000-b000-000000000002";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetJob.mockResolvedValue(undefined);
  mockEnv.SUPERSET_OAUTH_CLIENT_ID = "client-id";
  mockEnv.SUPERSET_ERASURE_ENABLED = true;
  mockEnv.SUPERSET_REDIS_URL = "redis://superset-cache:6379/1";
});

describe("enqueueSupersetErasure (#728)", () => {
  it("queues a user job under a deterministic id built from the hashed subject", async () => {
    const request = {
      kind: "user",
      tenantId: TENANT,
      subject: "393014043322875906",
    } as const;
    expect(await enqueueSupersetErasure(request)).toBe(true);
    // The same id apps/worker/src/superset-erasure.ts builds (supersetErasureJobId); the mocked
    // auditResourceId above reverses the subject.
    expect(mockAdd).toHaveBeenCalledWith("erase", request, {
      jobId: `superset-erasure-user-${TENANT}-res-${[...request.subject].reverse().join("")}`,
    });
    expect(
      (mockAdd.mock.calls[0]?.[2] as { jobId: string }).jobId,
    ).not.toContain(request.subject);
  });

  it("accepts a subject with a colon: BullMQ ids cannot contain one, so the id is built from its hash", async () => {
    await enqueueSupersetErasure({
      kind: "user",
      tenantId: TENANT,
      subject: "a:b",
    });
    const options = mockAdd.mock.calls[0]?.[2] as { jobId: string };
    expect(options.jobId).toBe(`superset-erasure-user-${TENANT}-res-b_a`);
    expect(options.jobId).not.toContain(":");
  });

  it("queues a tenant job under a deterministic id", async () => {
    await enqueueSupersetErasure({ kind: "tenant", tenantId: TENANT });
    expect(mockAdd.mock.calls[0]?.[2]).toEqual({
      jobId: `superset-erasure-tenant-${TENANT}`,
    });
  });

  it("removes a failed or completed job with the same id first, so the new request really runs", async () => {
    for (const state of ["failed", "completed"]) {
      const remove = vi.fn(async () => {});
      mockGetJob.mockResolvedValueOnce({ getState: async () => state, remove });
      mockAdd.mockClear();
      expect(
        await enqueueSupersetErasure({ kind: "tenant", tenantId: TENANT }),
      ).toBe(true);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(mockAdd).toHaveBeenCalledTimes(1);
    }
  });

  it("leaves a job that is still queued or running alone and says so", async () => {
    for (const state of ["waiting", "delayed", "active"]) {
      const remove = vi.fn(async () => {});
      mockGetJob.mockResolvedValueOnce({ getState: async () => state, remove });
      mockAdd.mockClear();
      expect(
        await enqueueSupersetErasure({ kind: "tenant", tenantId: TENANT }),
      ).toBe(true);
      expect(remove).not.toHaveBeenCalled();
      expect(mockAdd).not.toHaveBeenCalled();
    }
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ state: "active" }),
      expect.stringContaining("already queued"),
    );
  });

  it("queues nothing with Stage 2 off, with the setting on or off", async () => {
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
    expect(
      await enqueueSupersetErasure({ kind: "tenant", tenantId: TENANT }),
    ).toBe(false);
    mockEnv.SUPERSET_ERASURE_ENABLED = false;
    expect(
      await enqueueSupersetErasure({ kind: "tenant", tenantId: TENANT }),
    ).toBe(false);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("still queues with Stage 2 on when the setting says off", async () => {
    mockEnv.SUPERSET_ERASURE_ENABLED = false;
    expect(
      await enqueueSupersetErasure({ kind: "tenant", tenantId: TENANT }),
    ).toBe(true);
  });

  it("never throws when the queue is down, points to the runbook, and counts it for the alert", async () => {
    mockAdd.mockRejectedValueOnce(new Error("redis down"));
    expect(
      await enqueueSupersetErasure({ kind: "tenant", tenantId: TENANT }),
    ).toBe(false);
    expect(mockError).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("runbook"),
    );
    expect(mockCount).toHaveBeenCalledWith(1, { outcome: "not_queued" });
  });

  it("starts the not-queued count at 0, so the first one still moves increase()", () => {
    expect(initialCounts).toContainEqual([0, { outcome: "not_queued" }]);
  });

  it("still queues when another request removed the old job a moment earlier", async () => {
    const remove = vi.fn(async () => {
      throw new Error("Missing key for job");
    });
    mockGetJob
      .mockResolvedValueOnce({ getState: async () => "failed", remove })
      .mockResolvedValueOnce(undefined);
    expect(
      await enqueueSupersetErasure({ kind: "tenant", tenantId: TENANT }),
    ).toBe(true);
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  it("reports not queued when the old failed job could not be removed and is still there", async () => {
    const stuck = {
      getState: async () => "failed",
      remove: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    mockGetJob.mockResolvedValueOnce(stuck).mockResolvedValueOnce(stuck);
    expect(
      await enqueueSupersetErasure({ kind: "tenant", tenantId: TENANT }),
    ).toBe(false);
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("eraseUserInSuperset (#728): what the admin is told", () => {
  const SUBJECT = "393014043322875906";
  const run = (wasMember = true) =>
    eraseUserInSuperset({ tenantId: TENANT, subject: SUBJECT, wasMember });

  it("queues a member's erasure with Stage 2 on", async () => {
    expect(await run()).toEqual({
      status: "queued",
      switchIgnored: false,
      message: "The user's Superset data is being erased.",
    });
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  it("does not queue for a person outside this tenant, and says why", async () => {
    const outcome = await run(false);
    expect(outcome.status).toBe("not_member");
    expect(outcome.message).toMatch(/not a member of this organisation/);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("still erases with Stage 2 on when the switch is off, warns, and says so", async () => {
    mockEnv.SUPERSET_ERASURE_ENABLED = false;
    const outcome = await run();
    expect(outcome).toMatchObject({ status: "queued", switchIgnored: true });
    expect(outcome.message).toMatch(
      /disabled, but it ran because Superset sign-in is on/,
    );
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it("erases nothing with Stage 2 off and the switch off, and says Superset erasure is disabled", async () => {
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
    mockEnv.SUPERSET_ERASURE_ENABLED = false;
    expect(await run()).toEqual({
      status: "disabled",
      switchIgnored: false,
      message:
        "Superset data was not erased because Superset erasure is disabled.",
    });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("with Stage 2 off and the switch on, only the cache is cleared", async () => {
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
    const outcome = await run();
    expect(outcome.status).toBe("cache_only");
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("does not claim the cache is being cleared when Superset has no cache configured", async () => {
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
    mockEnv.SUPERSET_REDIS_URL = undefined;
    const outcome = await run();
    expect(outcome.status).toBe("cache_only");
    expect(outcome.message).toContain("no cache to clear");
    expect(outcome.message).not.toContain("being cleared");
  });

  it("says when the erasure could not be scheduled", async () => {
    mockAdd.mockRejectedValueOnce(new Error("redis down"));
    const outcome = await run();
    expect(outcome.status).toBe("queue_failed");
    expect(outcome.message).toMatch(/operator must run it/);
  });

  it("never puts the subject or the tenant in the message", async () => {
    for (const wasMember of [true, false]) {
      const { message } = await run(wasMember);
      expect(message).not.toContain(SUBJECT);
      expect(message).not.toContain(TENANT);
    }
  });
});
