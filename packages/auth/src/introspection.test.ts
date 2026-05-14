import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@platform/config", () => ({
  env: {
    ZITADEL_INTROSPECTION_URL:
      "https://zitadel.example.com/oauth/v2/introspect",
    ZITADEL_INTROSPECTION_CLIENT_ID: "client-id",
    ZITADEL_INTROSPECTION_CLIENT_SECRET: "client-secret",
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Must import AFTER mocks are registered
const { introspectToken } = await import("./introspection.js");

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeFetchResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the module cache between tests so the internal Map is fresh.
  // We achieve this by passing unique tokens per test.
});

describe("introspectToken", () => {
  it("returns active result for a valid token", async () => {
    const activeResult = { active: true, sub: "user-123" };
    mockFetch.mockResolvedValueOnce(makeFetchResponse(activeResult));

    const result = await introspectToken("valid-token-1");

    expect(result.active).toBe(true);
    expect(result.sub).toBe("user-123");
  });

  it("returns inactive result when server responds with active=false", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ active: false }));

    const result = await introspectToken("invalid-token-2");

    expect(result.active).toBe(false);
  });

  it("returns inactive result when fetch throws a network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const result = await introspectToken("errored-token-3");

    expect(result.active).toBe(false);
  });

  it("returns inactive result when server returns non-2xx", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse({}, false, 503));

    const result = await introspectToken("bad-server-4");

    expect(result.active).toBe(false);
  });

  it("uses cached result on second call with same token", async () => {
    const activeResult = { active: true, sub: "user-cached" };
    mockFetch.mockResolvedValueOnce(makeFetchResponse(activeResult));

    const r1 = await introspectToken("cached-token-5");
    const r2 = await introspectToken("cached-token-5");

    expect(r1.active).toBe(true);
    expect(r2.active).toBe(true);
    // fetch should only be called once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
