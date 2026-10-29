import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockAdd,
  mockGetJob,
  initialCounts,
  mockWarn,
  mockError,
  mockInfo,
  mockEnv,
  mockWrite,
  mockCount,
  workers,
} = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockGetJob: vi.fn(),
  // What the module added to the counter while loading, before any test clears the mocks.
  initialCounts: [] as unknown[][],
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockInfo: vi.fn(),
  mockWrite: vi.fn(),
  mockCount: vi.fn(),
  workers: [] as Array<{ handlers: Record<string, (...a: unknown[]) => void> }>,
  mockEnv: {
    SUPERSET_INTERNAL_URL: "http://superset:8088",
    SUPERSET_SERVICE_ACCOUNT_USER: "service_account",
    SUPERSET_SERVICE_ACCOUNT_PASSWORD: "pw" as string | undefined,
    SUPERSET_OAUTH_CLIENT_ID: "client-id" as string | undefined,
    SUPERSET_ERASURE_ENABLED: true,
  },
}));

vi.mock("@platform/telemetry", () => ({
  Worker: class {
    handlers: Record<string, (...a: unknown[]) => void> = {};
    constructor() {
      workers.push(this);
    }
    on(event: string, fn: (...a: unknown[]) => void): void {
      this.handlers[event] = fn;
    }
    close = vi.fn();
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
  logger: { warn: mockWarn, info: mockInfo, error: mockError },
}));
vi.mock("@platform/db", () => ({
  withTenantContext: (_tenant: string, fn: (tx: unknown) => unknown) =>
    fn({ tx: true }),
}));
vi.mock("@platform/audit", () => ({
  writeAuditEntry: mockWrite,
  // Stand-in for the real uuid hash: never contains the id, and never a colon.
  auditResourceId: (id: string) =>
    `res-${[...id]
      .reverse()
      .join("")
      .replace(/[^A-Za-z0-9]/g, "_")}`,
}));
vi.mock("./queues.js", () => ({
  connection: {},
  supersetErasureQueue: { add: mockAdd, getJob: mockGetJob },
}));

const {
  supersetErasureBackoff,
  SUPERSET_ERASURE_ATTEMPTS,
  processSupersetErasure,
  enqueueSupersetErasure,
  eraseInSuperset,
  supersetErasureJobId,
  MAX_CALLS_PER_ATTEMPT,
  stopSupersetErasureWorker,
} = await import("./superset-erasure.js");

const TENANT = "bbbbbbbb-0002-4000-b000-000000000002";
const SUBJECT = "393014043322875906";
// What the mocked auditResourceId makes of SUBJECT: a stand-in for the real hash, which never contains the id.
const RESOURCE_ID = `res-${[...SUBJECT].reverse().join("")}`;

interface Reply {
  status?: number;
  body?: unknown;
}

/** A fake Superset: login, CSRF token, then one scripted reply per erase call. */
function fakeSuperset(erase: Reply[]): {
  calls: Array<{
    url: string;
    body?: unknown;
    headers: Record<string, string>;
  }>;
} {
  const calls: Array<{
    url: string;
    body?: unknown;
    headers: Record<string, string>;
  }> = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (
        url: string,
        init?: { body?: string; headers?: Record<string, string> },
      ) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(init.body) : undefined,
          headers: init?.headers ?? {},
        });
        if (url.endsWith("/security/login")) {
          return new Response(JSON.stringify({ access_token: "tok" }), {
            status: 200,
          });
        }
        if (url.endsWith("/security/csrf_token/")) {
          const res = new Response(JSON.stringify({ result: "csrf" }), {
            status: 200,
          });
          res.headers.append("set-cookie", "session=abc; HttpOnly; Path=/");
          return res;
        }
        const reply = erase[Math.min(i, erase.length - 1)] ?? { status: 200 };
        i += 1;
        return new Response(JSON.stringify(reply.body ?? {}), {
          status: reply.status ?? 200,
        });
      },
    ),
  );
  return { calls };
}

const done = (extra: Record<string, number> = {}): Reply => ({
  body: {
    matchedUsers: 1,
    heldUsers: 0,
    deletedRows: 18,
    cacheKeysRemoved: 4,
    more: false,
    ...extra,
  },
});

function job(
  data: unknown,
  attemptsMade = 0,
): Parameters<typeof processSupersetErasure>[0] & {
  updateData: ReturnType<typeof vi.fn>;
} {
  return { data, attemptsMade, updateData: vi.fn(async () => {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.SUPERSET_SERVICE_ACCOUNT_PASSWORD = "pw";
  mockEnv.SUPERSET_OAUTH_CLIENT_ID = "client-id";
  mockEnv.SUPERSET_ERASURE_ENABLED = true;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("retry schedule", () => {
  it("backs off 1, 2, 4, 8, 16, 32 minutes, then caps at 1 hour", () => {
    const minutes = [1, 2, 3, 4, 5, 6, 7, 8, 30].map(
      (n) => supersetErasureBackoff(n) / 60_000,
    );
    expect(minutes).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  it("keeps trying for at least 24 hours before the last attempt", () => {
    let waitedMs = 0;
    for (let attempt = 1; attempt < SUPERSET_ERASURE_ATTEMPTS; attempt++) {
      waitedMs += supersetErasureBackoff(attempt);
    }
    expect(waitedMs / 3_600_000).toBeGreaterThanOrEqual(24);
  });
});

describe("calling Superset", () => {
  it("logs in, then calls the user endpoint with the subject, CSRF token and session cookie", async () => {
    const { calls } = fakeSuperset([done()]);
    const summary = await eraseInSuperset({
      kind: "user",
      tenantId: TENANT,
      subject: SUBJECT,
    });
    const erase = calls[2];
    expect(erase?.url).toBe("http://superset:8088/openwind/erasure/user");
    expect(erase?.body).toEqual({ tenantId: TENANT, subject: SUBJECT });
    expect(erase?.headers).toMatchObject({
      Authorization: "Bearer tok",
      "X-CSRFToken": "csrf",
      Cookie: "session=abc",
    });
    expect(summary).toEqual({
      matchedUsers: 1,
      heldUsers: 0,
      deletedRows: 18,
      cacheKeysRemoved: 4,
      calls: 1,
    });
  });

  it("calls the tenant endpoint with no subject for a tenant job", async () => {
    const { calls } = fakeSuperset([done()]);
    await eraseInSuperset({ kind: "tenant", tenantId: TENANT });
    expect(calls[2]?.url).toBe("http://superset:8088/openwind/erasure/tenant");
    expect(calls[2]?.body).toEqual({ tenantId: TENANT });
  });

  it("calls again while Superset says there is more, and adds the counts up", async () => {
    const { calls } = fakeSuperset([
      {
        body: {
          matchedUsers: 1,
          heldUsers: 0,
          deletedRows: 5000,
          cacheKeysRemoved: 0,
          more: true,
        },
      },
      done({ deletedRows: 700 }),
    ]);
    const summary = await eraseInSuperset({ kind: "tenant", tenantId: TENANT });
    expect(summary).toMatchObject({
      deletedRows: 5700,
      cacheKeysRemoved: 4,
      calls: 2,
    });
    // One login and one CSRF token, shared by both erase calls.
    expect(calls.map((c) => c.url.replace("http://superset:8088", ""))).toEqual(
      [
        "/api/v1/security/login",
        "/api/v1/security/csrf_token/",
        "/openwind/erasure/tenant",
        "/openwind/erasure/tenant",
      ],
    );
  });

  it("stops a job that Superset never reports finished, after the call cap", async () => {
    const { calls } = fakeSuperset([
      {
        body: {
          matchedUsers: 1,
          heldUsers: 0,
          deletedRows: 1,
          cacheKeysRemoved: 0,
          more: true,
        },
      },
    ]);
    await expect(
      eraseInSuperset({ kind: "tenant", tenantId: TENANT }),
    ).rejects.toThrow(`did not finish within ${MAX_CALLS_PER_ATTEMPT} calls`);
    // login + CSRF token + one erase call per allowed call
    expect(calls).toHaveLength(2 + MAX_CALLS_PER_ATTEMPT);
  });

  it("fails when Superset answers an error, so the job is retried", async () => {
    fakeSuperset([{ status: 503, body: { message: "down" } }]);
    await expect(
      eraseInSuperset({ kind: "tenant", tenantId: TENANT }),
    ).rejects.toThrow("503");
  });

  it("fails when Superset is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(
      eraseInSuperset({ kind: "tenant", tenantId: TENANT }),
    ).rejects.toThrow("fetch failed");
  });

  it("fails without a service account password, without calling Superset", async () => {
    mockEnv.SUPERSET_SERVICE_ACCOUNT_PASSWORD = undefined;
    const { calls } = fakeSuperset([done()]);
    await expect(
      eraseInSuperset({ kind: "tenant", tenantId: TENANT }),
    ).rejects.toThrow("PASSWORD is not set");
    expect(calls).toHaveLength(0);
  });

  it("gives up on a reply it does not understand", async () => {
    fakeSuperset([{ body: { surprise: true } }]);
    await expect(
      eraseInSuperset({ kind: "tenant", tenantId: TENANT }),
    ).rejects.toThrow();
  });
});

describe("the job", () => {
  it("records a completed audit row linked to the platform's user row, with counts only", async () => {
    fakeSuperset([done({ heldUsers: 1 })]);
    await processSupersetErasure(
      job({ kind: "user", tenantId: TENANT, subject: SUBJECT }, 2),
    );
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const entry = mockWrite.mock.calls[0]?.[1];
    expect(entry).toMatchObject({
      tenantId: TENANT,
      actorId: "system",
      actorType: "system",
      resourceType: "user",
      resourceId: RESOURCE_ID,
      action: "superset_erasure.completed",
      metadata: {
        kind: "user",
        attempts: 3,
        matchedUsers: 1,
        heldUsers: 1,
        deletedRows: 18,
        cacheKeysRemoved: 4,
        calls: 1,
      },
    });
    expect(JSON.stringify(entry)).not.toContain(SUBJECT);
    expect(mockCount).toHaveBeenCalledWith(1, { outcome: "completed" });
    expect(mockWarn).toHaveBeenCalled();
  });

  it("links a tenant job to the tenant's purge row", async () => {
    fakeSuperset([done()]);
    await processSupersetErasure(job({ kind: "tenant", tenantId: TENANT }));
    expect(mockWrite.mock.calls[0]?.[1]).toMatchObject({
      resourceType: "tenant",
      resourceId: TENANT,
    });
  });

  it("keeps the counts on the job, so a retry after a failed audit write does not record zeros", async () => {
    fakeSuperset([done()]);
    mockWrite.mockRejectedValueOnce(new Error("db down"));
    const first = job({ kind: "tenant", tenantId: TENANT });
    await expect(processSupersetErasure(first)).rejects.toThrow("db down");
    const saved = first.updateData.mock.calls[0]?.[0] as { result: unknown };
    expect(saved.result).toMatchObject({ deletedRows: 18 });

    const fetchCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    await processSupersetErasure(job(saved, 1));
    expect(
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(fetchCalls);
    expect(mockWrite.mock.calls[1]?.[1]).toMatchObject({
      action: "superset_erasure.completed",
      metadata: { deletedRows: 18 },
    });
  });

  it("does not retry a job that can never succeed", async () => {
    for (const data of [
      { kind: "user", tenantId: TENANT },
      { kind: "tenant", tenantId: TENANT, subject: SUBJECT },
      { kind: "user", tenantId: "not-a-uuid", subject: SUBJECT },
      { kind: "user", tenantId: TENANT, subject: "bad subject; drop" },
    ]) {
      await expect(processSupersetErasure(job(data))).rejects.toMatchObject({
        name: "UnrecoverableError",
      });
    }
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe("metrics", () => {
  it("starts every outcome at 0, so the first failure of a process still moves increase()", () => {
    expect(initialCounts).toContainEqual([0, { outcome: "failed" }]);
    expect(initialCounts).toContainEqual([0, { outcome: "completed" }]);
    expect(initialCounts).toContainEqual([0, { outcome: "not_queued" }]);
  });
});

describe("failure handling", () => {
  const failed = (): ((j: unknown, err: unknown) => void) =>
    (workers[0]?.handlers["failed"] ?? (() => {})) as (
      j: unknown,
      err: unknown,
    ) => void;
  const queued = (attemptsMade: number): unknown => ({
    data: { kind: "user", tenantId: TENANT, subject: SUBJECT },
    attemptsMade,
    opts: { attempts: SUPERSET_ERASURE_ATTEMPTS },
  });

  it("only warns while attempts remain: no audit row, no failure count", () => {
    failed()(queued(1), new Error("503"));
    expect(mockWarn).toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("writes exactly one failed audit row and counts it on the last attempt", async () => {
    failed()(queued(SUPERSET_ERASURE_ATTEMPTS), new Error("503"));
    await vi.waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
    expect(mockWrite.mock.calls[0]?.[1]).toMatchObject({
      tenantId: TENANT,
      actorType: "system",
      resourceType: "user",
      resourceId: RESOURCE_ID,
      action: "superset_erasure.failed",
      metadata: { kind: "user", attempts: SUPERSET_ERASURE_ATTEMPTS },
    });
    expect(JSON.stringify(mockWrite.mock.calls[0]?.[1])).not.toContain("503");
    expect(mockCount).toHaveBeenCalledWith(1, { outcome: "failed" });
    expect(mockError).toHaveBeenCalled();
  });

  it("treats an unrecoverable job as final straight away", async () => {
    const { UnrecoverableError } = await import("bullmq");
    failed()(queued(1), new UnrecoverableError("bad job"));
    await vi.waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
  });

  it("waits for a failure row still being written before shutting down", async () => {
    let finish: () => void = () => {};
    mockWrite.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    failed()(queued(SUPERSET_ERASURE_ATTEMPTS), new Error("503"));
    await vi.waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = stopSupersetErasureWorker().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("logs, and does not throw, when even the failure row cannot be written", async () => {
    mockWrite.mockRejectedValueOnce(new Error("db down"));
    failed()(queued(SUPERSET_ERASURE_ATTEMPTS), new Error("503"));
    await vi.waitFor(() =>
      expect(mockError).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("failure audit entry"),
      ),
    );
  });
});

describe("queueing", () => {
  beforeEach(() => {
    mockGetJob.mockResolvedValue(undefined);
  });

  it("builds the user job id from the hashed subject, so a subject with a colon is accepted by BullMQ", () => {
    const id = supersetErasureJobId({
      kind: "user",
      tenantId: TENANT,
      subject: "a:b",
    });
    expect(id).toBe(`superset-erasure-user-${TENANT}-res-b_a`);
    expect(id).not.toContain(":");
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

  it("queues a user job with a deterministic id when Stage 2 is on", async () => {
    expect(
      await enqueueSupersetErasure({
        kind: "user",
        tenantId: TENANT,
        subject: SUBJECT,
      }),
    ).toBe(true);
    expect(mockAdd).toHaveBeenCalledWith(
      "erase",
      { kind: "user", tenantId: TENANT, subject: SUBJECT },
      { jobId: `superset-erasure-user-${TENANT}-${RESOURCE_ID}` },
    );
  });

  it("queues a tenant job with a deterministic id", async () => {
    await enqueueSupersetErasure({ kind: "tenant", tenantId: TENANT });
    expect(mockAdd.mock.calls[0]?.[2]).toEqual({
      jobId: `superset-erasure-tenant-${TENANT}`,
    });
  });

  it("queues nothing when Stage 2 is off (only the cache flush runs)", async () => {
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

  it("still queues with Stage 2 on when the setting says off: the setting cannot turn it off", async () => {
    mockEnv.SUPERSET_ERASURE_ENABLED = false;
    expect(
      await enqueueSupersetErasure({ kind: "tenant", tenantId: TENANT }),
    ).toBe(true);
  });

  it("never throws when the queue is down, says how to run it by hand, and counts it for the alert", async () => {
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
    expect(mockCount).toHaveBeenCalledWith(1, { outcome: "not_queued" });
  });
});
