import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

vi.mock("./api.js", () => ({
  fetchWithAuth: vi.fn(),
  API_URL: "/api",
}));

const api = await import("./api.js");
const fetchWithAuth = vi.mocked(api.fetchWithAuth);
const { fetchUsersShared, useUsers, clearUsersCache, USERS_CACHE_TTL_MS } =
  await import("./use-users.js");
const { emitSessionEnd } = await import("./session-events.js");

describe("use-users and fetchUsersShared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearUsersCache();
  });

  afterEach(() => {
    cleanup();
  });

  it("fetches and returns users", async () => {
    fetchWithAuth.mockResolvedValueOnce({
      data: [
        { userId: "u1", email: "alice@example.com", displayName: "Alice" },
      ],
    });

    const users = await fetchUsersShared();
    expect(users).toEqual([
      { userId: "u1", email: "alice@example.com", displayName: "Alice" },
    ]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent in-flight requests into a single network call", async () => {
    let resolveCall: (value: {
      data: Array<{ userId: string; email: string; displayName: string }>;
    }) => void;
    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCall = resolve;
      }),
    );

    const call1 = fetchUsersShared();
    const call2 = fetchUsersShared();
    const call3 = fetchUsersShared();

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    resolveCall!({
      data: [
        { userId: "u1", email: "alice@example.com", displayName: "Alice" },
      ],
    });

    const [r1, r2, r3] = await Promise.all([call1, call2, call3]);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("reuses cached users on subsequent calls", async () => {
    fetchWithAuth.mockResolvedValueOnce({
      data: [
        { userId: "u1", email: "alice@example.com", displayName: "Alice" },
      ],
    });

    await fetchUsersShared();
    const secondCall = await fetchUsersShared();

    expect(secondCall).toHaveLength(1);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("loads users via useUsers hook", async () => {
    fetchWithAuth.mockResolvedValueOnce({
      data: [
        { userId: "u1", email: "alice@example.com", displayName: "Alice" },
      ],
    });

    const { result } = renderHook(() => useUsers());
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.users).toHaveLength(1);
    expect(result.current.users[0]?.displayName).toBe("Alice");
  });

  it("refetches after the cache TTL expires", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    fetchWithAuth.mockResolvedValueOnce({ data: [{ userId: "u1" }] });
    await fetchUsersShared();
    await fetchUsersShared();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000 + USERS_CACHE_TTL_MS + 1);
    fetchWithAuth.mockResolvedValueOnce({ data: [{ userId: "u2" }] });
    const users = await fetchUsersShared();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(users).toEqual([{ userId: "u2" }]);
    now.mockRestore();
  });

  it("does not repopulate the cache from a request started before a clear", async () => {
    let resolveStale: (v: {
      data: Array<{ userId: string }>;
    }) => void = () => {};
    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve as typeof resolveStale;
      }),
    );
    const stale = fetchUsersShared();
    clearUsersCache();
    resolveStale({ data: [{ userId: "old-identity" }] });
    await stale;

    fetchWithAuth.mockResolvedValueOnce({ data: [{ userId: "new-identity" }] });
    const users = await fetchUsersShared();
    expect(users).toEqual([{ userId: "new-identity" }]);
  });

  it("clears the cache when the session ends", async () => {
    fetchWithAuth.mockResolvedValueOnce({ data: [{ userId: "u1" }] });
    await fetchUsersShared();
    emitSessionEnd();
    fetchWithAuth.mockResolvedValueOnce({ data: [{ userId: "u2" }] });
    expect(await fetchUsersShared()).toEqual([{ userId: "u2" }]);
  });

  it("does not cache failures", async () => {
    fetchWithAuth.mockRejectedValueOnce(new Error("boom"));
    expect(await fetchUsersShared()).toEqual([]);
    fetchWithAuth.mockResolvedValueOnce({ data: [{ userId: "u1" }] });
    expect(await fetchUsersShared()).toEqual([{ userId: "u1" }]);
  });

  it("rejects concurrent callers cleanly on failure and allows immediate retry", async () => {
    let rejectCall: (err: Error) => void;
    fetchWithAuth.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectCall = reject;
      }),
    );

    const call1 = fetchUsersShared();
    const call2 = fetchUsersShared();

    rejectCall!(new Error("network error"));

    const [r1, r2] = await Promise.all([call1, call2]);
    expect(r1).toEqual([]);
    expect(r2).toEqual([]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    // Immediate subsequent call retries network request
    fetchWithAuth.mockResolvedValueOnce({ data: [{ userId: "u1" }] });
    const retryResult = await fetchUsersShared();
    expect(retryResult).toEqual([{ userId: "u1" }]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it("respects exact TTL boundary (valid at TTL-1ms, expired at TTL)", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(10_000);
    fetchWithAuth.mockResolvedValueOnce({ data: [{ userId: "u1" }] });
    await fetchUsersShared();

    // 59,999 ms after caching -> still valid, hits cache
    now.mockReturnValue(10_000 + USERS_CACHE_TTL_MS - 1);
    const hit = await fetchUsersShared();
    expect(hit).toEqual([{ userId: "u1" }]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    // 60,000 ms after caching -> expired, refetches
    now.mockReturnValue(10_000 + USERS_CACHE_TTL_MS);
    fetchWithAuth.mockResolvedValueOnce({ data: [{ userId: "u2" }] });
    const miss = await fetchUsersShared();
    expect(miss).toEqual([{ userId: "u2" }]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it("handles multi-generation stale-write races under concurrency", async () => {
    let resolveGen0: (v: {
      data: Array<{ userId: string }>;
    }) => void = () => {};
    let resolveGen1: (v: {
      data: Array<{ userId: string }>;
    }) => void = () => {};
    let resolveGen2: (v: {
      data: Array<{ userId: string }>;
    }) => void = () => {};

    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGen0 = resolve as typeof resolveGen0;
      }),
    );
    const req0 = fetchUsersShared(); // generation 0

    clearUsersCache(); // generation becomes 1

    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGen1 = resolve as typeof resolveGen1;
      }),
    );
    const req1 = fetchUsersShared(); // generation 1

    clearUsersCache(); // generation becomes 2

    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGen2 = resolve as typeof resolveGen2;
      }),
    );
    const req2 = fetchUsersShared(); // generation 2

    // Resolve in reverse order or arbitrary interleaving
    resolveGen0({ data: [{ userId: "stale-gen-0" }] });
    resolveGen1({ data: [{ userId: "stale-gen-1" }] });
    resolveGen2({ data: [{ userId: "fresh-gen-2" }] });

    const [res0, res1, res2] = await Promise.all([req0, req1, req2]);
    expect(res0).toEqual([{ userId: "stale-gen-0" }]);
    expect(res1).toEqual([{ userId: "stale-gen-1" }]);
    expect(res2).toEqual([{ userId: "fresh-gen-2" }]);

    // Only req2 (gen 2) should populate the cache
    const cached = await fetchUsersShared();
    expect(cached).toEqual([{ userId: "fresh-gen-2" }]);
    // No new network request since gen 2's result is in cache
    expect(fetchWithAuth).toHaveBeenCalledTimes(3);
  });

  it("discards slow in-flight fetch resolving after TTL expiration if cache was cleared", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);

    let resolveSlow: (v: {
      data: Array<{ userId: string }>;
    }) => void = () => {};
    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSlow = resolve as typeof resolveSlow;
      }),
    );

    const slowReq = fetchUsersShared();

    // Advance time beyond TTL
    now.mockReturnValue(1_000 + USERS_CACHE_TTL_MS + 5_000);
    // User logs out after TTL expired while request was still running
    clearUsersCache();

    // Slow request resolves
    resolveSlow({ data: [{ userId: "stale-slow-user" }] });
    await slowReq;

    // Cache should remain empty because generation changed
    fetchWithAuth.mockResolvedValueOnce({ data: [{ userId: "new-user" }] });
    const fresh = await fetchUsersShared();
    expect(fresh).toEqual([{ userId: "new-user" }]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it("handles slow in-flight fetch resolving after TTL duration without clear by setting fresh timestamp", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);

    let resolveSlow: (v: {
      data: Array<{ userId: string }>;
    }) => void = () => {};
    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSlow = resolve as typeof resolveSlow;
      }),
    );

    const slowReq = fetchUsersShared();

    // Request takes 70 seconds
    now.mockReturnValue(71_000);
    resolveSlow({ data: [{ userId: "slow-user" }] });
    await slowReq;

    // Resolution timestamp is 71,000. Cache is fresh at 72,000 (1 second after resolution)
    now.mockReturnValue(72_000);
    const hit = await fetchUsersShared();
    expect(hit).toEqual([{ userId: "slow-user" }]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    // Expires 60s after resolution (71,000 + 60,000 + 1 = 131,001)
    now.mockReturnValue(131_001);
    fetchWithAuth.mockResolvedValueOnce({ data: [{ userId: "next-user" }] });
    const miss = await fetchUsersShared();
    expect(miss).toEqual([{ userId: "next-user" }]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it("ensures useUsers hook transitions across session end without leaking across accounts", async () => {
    fetchWithAuth.mockResolvedValueOnce({
      data: [
        { userId: "u1", email: "user1@tenant1.com", displayName: "User 1" },
      ],
    });

    const { result: session1, unmount: unmount1 } = renderHook(() =>
      useUsers(),
    );
    await waitFor(() => {
      expect(session1.current.loading).toBe(false);
    });
    expect(session1.current.users[0]?.userId).toBe("u1");

    unmount1();

    // Session ends (logout)
    emitSessionEnd();

    // New user logs in
    fetchWithAuth.mockResolvedValueOnce({
      data: [
        { userId: "u2", email: "user2@tenant2.com", displayName: "User 2" },
      ],
    });

    const { result: session2 } = renderHook(() => useUsers());
    // Initial state is empty & loading
    expect(session2.current.loading).toBe(true);
    expect(session2.current.users).toEqual([]);

    await waitFor(() => {
      expect(session2.current.loading).toBe(false);
    });
    expect(session2.current.users[0]?.userId).toBe("u2");
  });
});
