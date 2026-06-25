import type { IncomingMessage, ClientRequest } from "node:http";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("@platform/config", () => ({
  env: {
    ZITADEL_ISSUER: "https://zitadel.example.com",
    ZITADEL_INTROSPECTION_URL:
      "https://zitadel.example.com/oauth/v2/introspect",
    ZITADEL_INTROSPECTION_CLIENT_ID: "client-id",
    ZITADEL_INTROSPECTION_CLIENT_SECRET: "client-secret",
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock node:http so tests don't make real network calls.
// The implementation uses node:http.request (not fetch) to set a custom Host
// header for Zitadel's internal-Docker routing.
const mockRequest = vi.fn();
vi.mock("node:http", () => ({ request: mockRequest }));

// Must import AFTER mocks are registered
const { introspectToken } = await import("./introspection.js");

function makeHttpResponse(
  statusCode = 200,
): EventEmitter & { statusCode: number } {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = statusCode;
  return res;
}

function makeHttpRequest(res: EventEmitter): Partial<ClientRequest> {
  const req: Partial<ClientRequest> = {
    setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
    on: vi.fn() as unknown as ClientRequest["on"],
    write: vi.fn() as unknown as ClientRequest["write"],
    end: vi.fn() as unknown as ClientRequest["end"],
  };
  // Trigger callback on next tick to simulate async
  mockRequest.mockImplementationOnce(
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
    mockRequest.mockImplementationOnce(() => req);

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
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
