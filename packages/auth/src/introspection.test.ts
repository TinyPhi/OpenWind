import type { IncomingMessage, ClientRequest } from "node:http";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Mutable so the scheme-selection tests below can point ZITADEL_INTROSPECTION_URL
// at an http:// (local Docker zitadel:8080) URL for one test, then restore it.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    ZITADEL_ISSUER: "https://zitadel.example.com",
    ZITADEL_INTROSPECTION_URL:
      "https://zitadel.example.com/oauth/v2/introspect",
    ZITADEL_INTROSPECTION_CLIENT_ID: "client-id",
    ZITADEL_INTROSPECTION_CLIENT_SECRET: "client-secret",
  },
}));
vi.mock("@platform/config", () => ({ env: mockEnv }));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock node:http/node:https so tests don't make real network calls.
// The implementation uses node:http/https.request (not fetch) to set a
// custom Host header for Zitadel's internal-Docker routing.
const mockRequest = vi.fn();
const mockHttpsRequest = vi.fn();
vi.mock("node:http", () => ({ request: mockRequest }));
vi.mock("node:https", () => ({ request: mockHttpsRequest }));

// Must import AFTER mocks are registered
const { introspectToken } = await import("./introspection.js");

function makeHttpResponse(
  statusCode = 200,
): EventEmitter & { statusCode: number } {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = statusCode;
  return res;
}

// The mocked @platform/config env above uses an https:// introspection URL —
// the real, common case (a hosted Zitadel) — so by default requests go
// through node:https, not node:http. Tests targeting the http:// (local
// Docker zitadel:8080) case mock `mockRequest` directly instead.
function makeHttpRequest(
  res: EventEmitter,
  mock: ReturnType<typeof vi.fn> = mockHttpsRequest,
): Partial<ClientRequest> {
  const req: Partial<ClientRequest> = {
    setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
    on: vi.fn() as unknown as ClientRequest["on"],
    write: vi.fn() as unknown as ClientRequest["write"],
    end: vi.fn() as unknown as ClientRequest["end"],
  };
  // Trigger callback on next tick to simulate async
  mock.mockImplementationOnce(
    (_opts: unknown, callback: (res: IncomingMessage) => void) => {
      setTimeout(() => callback(res as unknown as IncomingMessage), 0);
      return req;
    },
  );
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("introspectToken", () => {
  it("returns active result for a valid token", async () => {
    const body = JSON.stringify({ active: true, sub: "user-123" });
    const res = makeHttpResponse();
    makeHttpRequest(res);

    const promise = introspectToken("valid-token-1a");
    // emit data + end on next tick
    setTimeout(() => {
      res.emit("data", Buffer.from(body));
      res.emit("end");
    }, 1);

    const result = await promise;
    expect(result.active).toBe(true);
    expect(result.sub).toBe("user-123");
  });

  it("returns inactive result when server responds with active=false", async () => {
    const body = JSON.stringify({ active: false });
    const res = makeHttpResponse();
    makeHttpRequest(res);

    const promise = introspectToken("invalid-token-2a");
    setTimeout(() => {
      res.emit("data", Buffer.from(body));
      res.emit("end");
    }, 1);

    const result = await promise;
    expect(result.active).toBe(false);
  });

  it("returns inactive result when fetch throws a network error", async () => {
    const req: Partial<ClientRequest> = {
      setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
      on: vi.fn((event: string, handler: (err: Error) => void) => {
        if (event === "error")
          setTimeout(() => handler(new Error("network error")), 1);
      }) as unknown as ClientRequest["on"],
      write: vi.fn() as unknown as ClientRequest["write"],
      end: vi.fn() as unknown as ClientRequest["end"],
    };
    mockHttpsRequest.mockImplementationOnce(() => req);

    const result = await introspectToken("errored-token-3a");
    expect(result.active).toBe(false);
  });

  it("returns inactive result when server returns non-2xx", async () => {
    const res = makeHttpResponse(503);
    makeHttpRequest(res);

    const promise = introspectToken("bad-server-4a");
    setTimeout(() => {
      res.emit("data", Buffer.from("{}"));
      res.emit("end");
    }, 1);

    const result = await promise;
    expect(result.active).toBe(false);
  });

  it("returns inactive result when Zitadel response is not valid JSON (#238)", async () => {
    const res = makeHttpResponse(200);
    makeHttpRequest(res);

    const promise = introspectToken("malformed-json-token-6a");
    setTimeout(() => {
      res.emit("data", Buffer.from("not-json{{{"));
      res.emit("end");
    }, 1);

    const result = await promise;
    expect(result.active).toBe(false);
  });

  it("uses cached result on second call with same token", async () => {
    const body = JSON.stringify({ active: true, sub: "user-cached" });
    const res = makeHttpResponse();
    makeHttpRequest(res);

    const promise = introspectToken("cached-token-5a");
    setTimeout(() => {
      res.emit("data", Buffer.from(body));
      res.emit("end");
    }, 1);

    const r1 = await promise;
    const r2 = await introspectToken("cached-token-5a");

    expect(r1.active).toBe(true);
    expect(r2.active).toBe(true);
    // node:http.request should only be called once — second call hits cache
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
  });

  // #8: cache key switched from a 32-bit djb2 hash to SHA-256, so two
  // distinct tokens can never collide onto the same cache entry.
  it("caches distinct tokens independently, not sharing a bucket", async () => {
    const bodyA = JSON.stringify({ active: true, sub: "user-a" });
    const bodyB = JSON.stringify({ active: false, sub: "user-b" });

    const resA = makeHttpResponse();
    makeHttpRequest(resA);
    const promiseA = introspectToken("token-a");
    setTimeout(() => {
      resA.emit("data", Buffer.from(bodyA));
      resA.emit("end");
    }, 1);
    const resultA = await promiseA;

    const resB = makeHttpResponse();
    makeHttpRequest(resB);
    const promiseB = introspectToken("token-b");
    setTimeout(() => {
      resB.emit("data", Buffer.from(bodyB));
      resB.emit("end");
    }, 1);
    const resultB = await promiseB;

    expect(resultA.active).toBe(true);
    expect(resultA.sub).toBe("user-a");
    expect(resultB.active).toBe(false);
    expect(resultB.sub).toBe("user-b");
    // Two distinct tokens -> two real network calls, no cache-key collision.
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
  });
});

// Regression coverage for the bug where httpPostForm always used node:http
// and defaulted to port 80, silently redirecting (301) instead of reaching
// a real HTTPS Zitadel host's introspection endpoint.
describe("introspectToken — scheme selection (https vs http)", () => {
  it("uses node:https with port 443 when ZITADEL_INTROSPECTION_URL is https:// with no explicit port", async () => {
    const body = JSON.stringify({ active: true, sub: "https-user" });
    const res = makeHttpResponse();
    makeHttpRequest(res, mockHttpsRequest);

    const promise = introspectToken("https-scheme-token");
    setTimeout(() => {
      res.emit("data", Buffer.from(body));
      res.emit("end");
    }, 1);

    const result = await promise;
    expect(result.active).toBe(true);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).not.toHaveBeenCalled();
    const [opts] = mockHttpsRequest.mock.calls[0] as [{ port: number }];
    expect(opts.port).toBe(443);
  });

  it("still uses node:http with port 80 for a plain http:// URL (local Docker zitadel:8080 case)", async () => {
    mockEnv.ZITADEL_INTROSPECTION_URL =
      "http://zitadel:8080/oauth/v2/introspect";
    try {
      const body = JSON.stringify({ active: true, sub: "http-user" });
      const res = makeHttpResponse();
      makeHttpRequest(res, mockRequest);

      const promise = introspectToken("http-scheme-token");
      setTimeout(() => {
        res.emit("data", Buffer.from(body));
        res.emit("end");
      }, 1);

      const result = await promise;
      expect(result.active).toBe(true);
      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockHttpsRequest).not.toHaveBeenCalled();
      const [opts] = mockRequest.mock.calls[0] as [{ port: number }];
      expect(opts.port).toBe(8080);
    } finally {
      mockEnv.ZITADEL_INTROSPECTION_URL =
        "https://zitadel.example.com/oauth/v2/introspect";
    }
  });
});
