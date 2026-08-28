import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn() },
}));

const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
vi.mock("@platform/redis", () => ({
  getRedis: vi.fn(() => ({
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
  })),
}));

// Row returned by the cache-lookup SELECT. undefined = "no cached row".
let mockCachedRow:
  | { contentHash: string; responseStatus: number; responseBody: unknown }
  | undefined;
const mockInsertValues = vi.fn();
const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn().mockReturnValue({
  where: vi.fn().mockResolvedValue(undefined),
});

vi.mock("@platform/db", () => ({
  idempotencyKeys: {
    tenantId: "idempotency_keys.tenant_id",
    apiKeyId: "idempotency_keys.api_key_id",
    actingPersonId: "idempotency_keys.acting_person_id",
    idempotencyKey: "idempotency_keys.idempotency_key",
    contentHash: "idempotency_keys.content_hash",
    responseStatus: "idempotency_keys.response_status",
    responseBody: "idempotency_keys.response_body",
    expiresAt: "idempotency_keys.expires_at",
  },
  withTenantContext: vi.fn((_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi
              .fn()
              .mockResolvedValue(mockCachedRow ? [mockCachedRow] : []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: (v: unknown) => {
          mockInsertValues(v);
          return { onConflictDoNothing: mockOnConflictDoNothing };
        },
      })),
      delete: mockDelete,
    }),
  ),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...conds) => ({ op: "and", conds })),
  gt: vi.fn((col, val) => ({ col, val, op: "gt" })),
  lte: vi.fn((col, val) => ({ col, val, op: "lte" })),
}));

const { computeContentHash, withIdempotency } =
  await import("./idempotency.js");

describe("computeContentHash", () => {
  it("is stable regardless of key insertion order (RFC 8785)", async () => {
    const a = await computeContentHash({ b: 2, a: 1 });
    const b = await computeContentHash({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("differs when content differs", async () => {
    const a = await computeContentHash({ a: 1 });
    const b = await computeContentHash({ a: 2 });
    expect(a).not.toBe(b);
  });
});

describe("withIdempotency", () => {
  const scope = {
    tenantId: "tenant-a",
    applicationActorId: "key-1",
    actingPersonId: "person-1",
  };
  const content = { foo: "bar" };

  beforeEach(() => {
    mockCachedRow = undefined;
    mockRedisSet.mockReset();
    mockRedisDel.mockReset();
    mockInsertValues.mockReset();
    mockDelete.mockClear();
  });

  it("runs execute() directly with no db/redis calls when no idempotency key is given", async () => {
    const execute = vi.fn().mockResolvedValue({ status: 201, body: {} });
    const result = await withIdempotency(scope, content, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 201, body: {} });
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("rejects with 400 without touching db/redis when the key exceeds the max length", async () => {
    const execute = vi.fn();
    const result = await withIdempotency(
      { ...scope, idempotencyKey: "x".repeat(256) },
      content,
      execute,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe(
      "IDEMPOTENCY_KEY_INVALID",
    );
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("returns the cached result without calling execute() on a same-content replay", async () => {
    mockCachedRow = {
      contentHash: await computeContentHash(content),
      responseStatus: 201,
      responseBody: { data: { id: "abc" } },
    };
    const execute = vi.fn().mockResolvedValue({ status: 201, body: {} });

    const result = await withIdempotency(
      { ...scope, idempotencyKey: "key-1" },
      content,
      execute,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 201,
      body: { data: { id: "abc" } },
    });
  });

  it("returns 409 conflict without calling execute() when content differs from the cached hash", async () => {
    mockCachedRow = {
      contentHash: await computeContentHash({ different: true }),
      responseStatus: 201,
      responseBody: {},
    };
    const execute = vi.fn().mockResolvedValue({ status: 201, body: {} });

    const result = await withIdempotency(
      { ...scope, idempotencyKey: "key-1" },
      content,
      execute,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe(409);
    expect((result.body as { error: string }).error).toBe(
      "IDEMPOTENCY_KEY_CONFLICT",
    );
  });

  it("runs execute() and caches the result when the lock is acquired", async () => {
    mockRedisSet.mockResolvedValue("OK");
    const execute = vi
      .fn()
      .mockResolvedValue({ status: 201, body: { data: { id: "new" } } });

    const result = await withIdempotency(
      { ...scope, idempotencyKey: "key-1" },
      content,
      execute,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 201, body: { data: { id: "new" } } });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        apiKeyId: "key-1",
        actingPersonId: "person-1",
        idempotencyKey: "key-1",
        responseStatus: 201,
      }),
    );
    expect(mockRedisDel).toHaveBeenCalled();
    // Clears any stale-but-not-yet-swept expired row for this exact scope
    // before inserting, so an expired row can never make the fresh insert
    // silently no-op (onConflictDoNothing would otherwise keep serving it).
    expect(mockDelete).toHaveBeenCalled();
  });

  it("returns 409 in-progress without calling execute() when the lock is already held", async () => {
    mockRedisSet.mockResolvedValue(null);
    const execute = vi.fn();

    const result = await withIdempotency(
      { ...scope, idempotencyKey: "key-1" },
      content,
      execute,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe(409);
    expect((result.body as { error: string }).error).toBe(
      "IDEMPOTENCY_IN_PROGRESS",
    );
  });

  it("fails open (still calls execute AND still caches) when Redis lock acquisition throws", async () => {
    mockRedisSet.mockRejectedValue(new Error("redis down"));
    const execute = vi.fn().mockResolvedValue({ status: 201, body: {} });

    const result = await withIdempotency(
      { ...scope, idempotencyKey: "key-1" },
      content,
      execute,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 201, body: {} });
    // The concurrency guarantee (R5) is not upheld during a Redis outage
    // (documented, accepted trade-off), but the result cache (R3/R4) still
    // gets written so behavior returns to normal as soon as Redis recovers.
    expect(mockInsertValues).toHaveBeenCalled();
  });

  it("re-checks the cache after acquiring the lock and skips execute() if a concurrent request already cached a result (double-checked locking)", async () => {
    // Simulates the exact race PR #500 fixed and PR #502 regressed: the
    // first lookup (before lock acquisition) misses, but by the time this
    // request acquires the lock, a faster concurrent request has already
    // executed and cached its result. The re-check after lock acquisition
    // must catch this, not just the pre-lock lookup.
    mockRedisSet.mockImplementation(async () => {
      mockCachedRow = {
        contentHash: await computeContentHash(content),
        responseStatus: 201,
        responseBody: { data: { id: "from-the-other-request" } },
      };
      return "OK";
    });
    const execute = vi.fn().mockResolvedValue({ status: 201, body: {} });

    const result = await withIdempotency(
      { ...scope, idempotencyKey: "key-1" },
      content,
      execute,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 201,
      body: { data: { id: "from-the-other-request" } },
    });
    // Still releases the lock it acquired, even on the cache-hit early return.
    expect(mockRedisDel).toHaveBeenCalled();
  });

  it("releases the lock even when execute() throws", async () => {
    mockRedisSet.mockResolvedValue("OK");
    const execute = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      withIdempotency({ ...scope, idempotencyKey: "key-1" }, content, execute),
    ).rejects.toThrow("boom");

    expect(mockRedisDel).toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("does not call execute() when a concurrent request populates the cache between the fast-path lookup and lock acquisition (TOCTOU fix)", async () => {
    // Scenario: request A's fast-path lookup misses (no cache), then request B
    // completes its entire cycle (execute → cache → release lock) before A
    // acquires the lock. Without the double-checked locking fix, A would
    // re-execute. With the fix, A's under-lock re-check finds the cached result
    // and returns it without calling execute().
    const cachedRow = {
      contentHash: await computeContentHash(content),
      responseStatus: 201,
      responseBody: { data: { id: "from-concurrent-request" } },
    };

    const { withTenantContext } = await import("@platform/db");
    // First call: fast-path lookup (no cache)
    vi.mocked(withTenantContext).mockImplementationOnce((_id, fn) =>
      fn({
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
          })),
        })),
        insert: vi.fn(() => ({
          values: (v: unknown) => {
            mockInsertValues(v);
            return { onConflictDoNothing: mockOnConflictDoNothing };
          },
        })),
        delete: mockDelete,
      }),
    );
    // Second call: under-lock re-check (concurrent request cached its result in the interim)
    vi.mocked(withTenantContext).mockImplementationOnce((_id, fn) =>
      fn({
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([cachedRow]),
            })),
          })),
        })),
        insert: vi.fn(() => ({
          values: (v: unknown) => {
            mockInsertValues(v);
            return { onConflictDoNothing: mockOnConflictDoNothing };
          },
        })),
        delete: mockDelete,
      }),
    );

    mockRedisSet.mockResolvedValue("OK");
    const execute = vi.fn().mockResolvedValue({ status: 201, body: {} });

    const result = await withIdempotency(
      { ...scope, idempotencyKey: "key-toctou" },
      content,
      execute,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 201,
      body: { data: { id: "from-concurrent-request" } },
    });
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});
