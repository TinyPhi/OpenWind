import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

import type { TenantUser } from "./use-users.js";

vi.mock("./api.js", () => ({
  fetchWithAuth: vi.fn(),
  API_URL: "/api",
}));

const api = await import("./api.js");
const fetchWithAuth = vi.mocked(api.fetchWithAuth);
const { fetchUsersShared, useUsers, clearUsersCache, USERS_CACHE_TTL_MS } =
  await import("./use-users.js");
const { emitSessionEnd } = await import("./session-events.js");

function createMockUser(
  userId: string,
  overrides?: Partial<TenantUser>,
): TenantUser {
  return {
    userId,
    email: null,
    displayName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("use-users and fetchUsersShared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearUsersCache();
  });

  afterEach(() => {
    cleanup();
  });

  it("fetches and returns users", async () => {
    const user = createMockUser("u1", {
      email: "alice@example.com",
      displayName: "Alice",
    });
    fetchWithAuth.mockResolvedValueOnce({
      data: [user],
    });

    const users = await fetchUsersShared();
    expect(users).toEqual([user]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent in-flight requests into a single network call", async () => {
    let resolveCall: (value: { data: TenantUser[] }) => void;
    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCall = resolve;
      }),
    );

    const call1 = fetchUsersShared();
    const call2 = fetchUsersShared();
    const call3 = fetchUsersShared();

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    const user = createMockUser("u1", {
      email: "alice@example.com",
      displayName: "Alice",
    });
    resolveCall!({
      data: [user],
    });

    const [r1, r2, r3] = await Promise.all([call1, call2, call3]);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("reuses cached users on subsequent calls", async () => {
    const user = createMockUser("u1", {
      email: "alice@example.com",
      displayName: "Alice",
    });
    fetchWithAuth.mockResolvedValueOnce({
      data: [user],
    });

    await fetchUsersShared();
    const secondCall = await fetchUsersShared();

    expect(secondCall).toHaveLength(1);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("loads users via useUsers hook", async () => {
    const user = createMockUser("u1", {
      email: "alice@example.com",
      displayName: "Alice",
    });
    fetchWithAuth.mockResolvedValueOnce({
      data: [user],
    });

    const { result } = renderHook(() => useUsers());
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.users).toHaveLength(1);
    expect(result.current.users[0]?.displayName).toBe("Alice");
    expect(result.current.users[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("initializes synchronously from fresh cache without re-fetching", async () => {
    const user = createMockUser("u1", { displayName: "Alice" });
    fetchWithAuth.mockResolvedValueOnce({ data: [user] });

    await fetchUsersShared();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    const { result } = renderHook(() => useUsers());
    expect(result.current.loading).toBe(false);
    expect(result.current.users).toEqual([user]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("refetches after the cache TTL expires", async () => {
    const u1 = createMockUser("u1");
    const u2 = createMockUser("u2");
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    fetchWithAuth.mockResolvedValueOnce({ data: [u1] });
    await fetchUsersShared();
    await fetchUsersShared();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000 + USERS_CACHE_TTL_MS + 1);
    fetchWithAuth.mockResolvedValueOnce({ data: [u2] });
    const users = await fetchUsersShared();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(users).toEqual([u2]);
    now.mockRestore();
  });

  it("does not repopulate the cache from a request started before a clear", async () => {
    const oldUser = createMockUser("old-identity");
    const newUser = createMockUser("new-identity");
    let resolveStale: (v: { data: TenantUser[] }) => void = () => {};
    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve as typeof resolveStale;
      }),
    );
    const stale = fetchUsersShared();
    clearUsersCache();
    resolveStale({ data: [oldUser] });
    await stale;

    fetchWithAuth.mockResolvedValueOnce({ data: [newUser] });
    const users = await fetchUsersShared();
    expect(users).toEqual([newUser]);
  });

  it("clears the cache when the session ends", async () => {
    const u1 = createMockUser("u1");
    const u2 = createMockUser("u2");
    fetchWithAuth.mockResolvedValueOnce({ data: [u1] });
    await fetchUsersShared();
    emitSessionEnd();
    fetchWithAuth.mockResolvedValueOnce({ data: [u2] });
    expect(await fetchUsersShared()).toEqual([u2]);
  });

  it("does not cache failures", async () => {
    const u1 = createMockUser("u1");
    fetchWithAuth.mockRejectedValueOnce(new Error("boom"));
    await expect(fetchUsersShared()).rejects.toThrow("boom");
    fetchWithAuth.mockResolvedValueOnce({ data: [u1] });
    expect(await fetchUsersShared()).toEqual([u1]);
  });

  it("rejects concurrent callers cleanly on failure and allows immediate retry", async () => {
    const u1 = createMockUser("u1");
    let rejectCall: (err: Error) => void;
    fetchWithAuth.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectCall = reject;
      }),
    );

    const call1 = fetchUsersShared();
    const call2 = fetchUsersShared();

    rejectCall!(new Error("network error"));

    await expect(call1).rejects.toThrow("network error");
    await expect(call2).rejects.toThrow("network error");
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    // Immediate subsequent call retries network request
    fetchWithAuth.mockResolvedValueOnce({ data: [u1] });
    const retryResult = await fetchUsersShared();
    expect(retryResult).toEqual([u1]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it("useUsers reports error (not an empty success) when the request fails, then recovers on remount", async () => {
    const u1 = createMockUser("u1");
    fetchWithAuth.mockRejectedValueOnce(new Error("boom"));

    const failed = renderHook(() => useUsers());
    await waitFor(() => expect(failed.result.current.loading).toBe(false));
    expect(failed.result.current.error).toBe(true);
    expect(failed.result.current.users).toEqual([]);
    failed.unmount();

    fetchWithAuth.mockResolvedValueOnce({ data: [u1] });
    const retried = renderHook(() => useUsers());
    await waitFor(() => expect(retried.result.current.loading).toBe(false));
    expect(retried.result.current.error).toBe(false);
    expect(retried.result.current.users).toEqual([u1]);
  });

  it("respects exact TTL boundary (valid at TTL-1ms, expired at TTL)", async () => {
    const u1 = createMockUser("u1");
    const u2 = createMockUser("u2");
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(10_000);
    fetchWithAuth.mockResolvedValueOnce({ data: [u1] });
    await fetchUsersShared();

    // 59,999 ms after caching -> still valid, hits cache
    now.mockReturnValue(10_000 + USERS_CACHE_TTL_MS - 1);
    const hit = await fetchUsersShared();
    expect(hit).toEqual([u1]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    // 60,000 ms after caching -> expired, refetches
    now.mockReturnValue(10_000 + USERS_CACHE_TTL_MS);
    fetchWithAuth.mockResolvedValueOnce({ data: [u2] });
    const miss = await fetchUsersShared();
    expect(miss).toEqual([u2]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it("handles multi-generation stale-write races under concurrency", async () => {
    const gen0 = createMockUser("stale-gen-0");
    const gen1 = createMockUser("stale-gen-1");
    const gen2 = createMockUser("fresh-gen-2");
    let resolveGen0: (v: { data: TenantUser[] }) => void = () => {};
    let resolveGen1: (v: { data: TenantUser[] }) => void = () => {};
    let resolveGen2: (v: { data: TenantUser[] }) => void = () => {};

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
    resolveGen0({ data: [gen0] });
    resolveGen1({ data: [gen1] });
    resolveGen2({ data: [gen2] });

    const [res0, res1, res2] = await Promise.all([req0, req1, req2]);
    expect(res0).toEqual([gen0]);
    expect(res1).toEqual([gen1]);
    expect(res2).toEqual([gen2]);

    // Only req2 (gen 2) should populate the cache
    const cached = await fetchUsersShared();
    expect(cached).toEqual([gen2]);
    // No new network request since gen 2's result is in cache
    expect(fetchWithAuth).toHaveBeenCalledTimes(3);
  });

  it("discards slow in-flight fetch resolving after TTL expiration if cache was cleared", async () => {
    const slowUser = createMockUser("stale-slow-user");
    const newUser = createMockUser("new-user");
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);

    let resolveSlow: (v: { data: TenantUser[] }) => void = () => {};
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
    resolveSlow({ data: [slowUser] });
    await slowReq;

    // Cache should remain empty because generation changed
    fetchWithAuth.mockResolvedValueOnce({ data: [newUser] });
    const fresh = await fetchUsersShared();
    expect(fresh).toEqual([newUser]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it("handles slow in-flight fetch resolving after TTL duration without clear by setting fresh timestamp", async () => {
    const slowUser = createMockUser("slow-user");
    const nextUser = createMockUser("next-user");
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);

    let resolveSlow: (v: { data: TenantUser[] }) => void = () => {};
    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSlow = resolve as typeof resolveSlow;
      }),
    );

    const slowReq = fetchUsersShared();

    // Request takes 70 seconds
    now.mockReturnValue(71_000);
    resolveSlow({ data: [slowUser] });
    await slowReq;

    // Resolution timestamp is 71,000. Cache is fresh at 72,000 (1 second after resolution)
    now.mockReturnValue(72_000);
    const hit = await fetchUsersShared();
    expect(hit).toEqual([slowUser]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    // Expires 60s after resolution (71,000 + 60,000 + 1 = 131,001)
    now.mockReturnValue(131_001);
    fetchWithAuth.mockResolvedValueOnce({ data: [nextUser] });
    const miss = await fetchUsersShared();
    expect(miss).toEqual([nextUser]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it("ensures useUsers hook transitions across session end without leaking across accounts", async () => {
    const u1 = createMockUser("u1", {
      email: "user1@tenant1.com",
      displayName: "User 1",
    });
    const u2 = createMockUser("u2", {
      email: "user2@tenant2.com",
      displayName: "User 2",
    });
    fetchWithAuth.mockResolvedValueOnce({
      data: [u1],
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
      data: [u2],
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
