import { describe, it, expect, vi, afterEach } from "vitest";

const mockFetchWithAuth = vi.fn();
vi.mock("./api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

const { listThirdPartyAccessLogs } =
  await import("./third-party-access-logs-client.js");

describe("listThirdPartyAccessLogs", () => {
  afterEach(() => {
    mockFetchWithAuth.mockReset();
  });

  it("returns data and nextCursor on a well-formed response", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      data: [{ id: "1" }],
      nextCursor: "abc",
    });
    const res = await listThirdPartyAccessLogs();
    expect(res.data).toHaveLength(1);
    expect(res.nextCursor).toBe("abc");
  });

  // PR #489 review, F-05 -- a malformed 2xx body must not silently render an
  // empty table; it should surface as an error instead.
  it("throws on a response missing a data array", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ error: "FORBIDDEN" });
    await expect(listThirdPartyAccessLogs()).rejects.toThrow(
      "Unexpected response shape",
    );
  });

  it("defaults nextCursor to null when absent", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    const res = await listThirdPartyAccessLogs();
    expect(res.nextCursor).toBeNull();
  });
});
