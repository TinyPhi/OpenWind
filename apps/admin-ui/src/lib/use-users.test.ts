import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

vi.mock("./api.js", () => ({
  fetchWithAuth: vi.fn(),
  API_URL: "/api",
}));

const api = await import("./api.js");
const fetchWithAuth = vi.mocked(api.fetchWithAuth);
const { fetchUsersShared, useUsers, clearUsersCache } =
  await import("./use-users.js");

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
});
