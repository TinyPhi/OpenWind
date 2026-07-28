import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetUser = vi.fn();
const mockSilentRefresh = vi.fn();
const mockWaitForAuth = vi.fn().mockResolvedValue(undefined);

vi.mock("../authProvider.js", () => ({
  userManager: { getUser: () => mockGetUser() },
  silentRefresh: () => mockSilentRefresh(),
  waitForAuth: () => mockWaitForAuth(),
}));

const { fetchRawWithAuth, fetchWithAuth } = await import("./api.js");

function jsonResponse(status: number, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("fetchRawWithAuth", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ access_token: "initial-token" });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the response directly on success (no retry)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: "ok" }));

    const res = await fetchRawWithAuth("/api/export/123");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockSilentRefresh).not.toHaveBeenCalled();
  });

  it("retries once via silentRefresh on a 401 and returns the retried response", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(200, { data: "ok-after-retry" }));
    mockSilentRefresh.mockResolvedValue("refreshed-token");

    const res = await fetchRawWithAuth("/api/export/123");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockSilentRefresh).toHaveBeenCalledTimes(1);
    // Retry request must carry the refreshed token
    const retryCall = fetchMock.mock.calls[1] as [string, { headers: Headers }];
    const retryHeaders = retryCall[1].headers;
    expect(retryHeaders.get("Authorization")).toBe("Bearer refreshed-token");
  });

  it("returns the original 401 response when silentRefresh fails to produce a new token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401));
    mockSilentRefresh.mockResolvedValue(null);

    const res = await fetchRawWithAuth("/api/export/123");

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithAuth 401 error shape", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ access_token: "initial-token" });
    mockSilentRefresh.mockResolvedValue(null);
    fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { message: "expired" }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws an error with isAuthError=true on 401, for authProvider.onError's auto-logout check", async () => {
    await expect(fetchWithAuth("/api/thing")).rejects.toMatchObject({
      status: 401,
      isAuthError: true,
    });
  });
});

describe("cross-origin URL rejection (CodeQL: server-side request forgery)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ access_token: "secret-token" });
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchWithAuth refuses a cross-origin URL and never attaches the bearer token", async () => {
    await expect(
      fetchWithAuth("https://attacker.example/steal"),
    ).rejects.toThrow(/cross-origin/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetchRawWithAuth refuses a cross-origin URL and never attaches the bearer token", async () => {
    await expect(
      fetchRawWithAuth("https://attacker.example/steal"),
    ).rejects.toThrow(/cross-origin/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetchWithAuth allows a root-relative same-origin path", async () => {
    const res = await fetchWithAuth("/api/thing");
    expect(res).toEqual({ data: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetchWithAuth refuses a protocol-relative URL (// is a different host)", async () => {
    await expect(fetchWithAuth("//attacker.example/steal")).rejects.toThrow(
      /cross-origin/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
