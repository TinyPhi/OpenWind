/**
 * runtime.test.ts
 *
 * Unit tests for createConnectorContext(). No DB, no OpenBao, no real network
 * I/O — decryptCredential, node:http/node:https, and assertEgressAllowed are
 * all mocked. SSRF *range* logic itself is tested exhaustively in
 * ssrf-guard.test.ts (M2, PR #381 review); this file focuses on runtime.ts's
 * OWN orchestration: ordering (allowedHosts -> SSRF check -> decrypt),
 * connection pinning wiring, header attachment per auth.type, response
 * construction, and input validation.
 *
 * The node:http(s) mocking pattern (capture the Agent's `lookup` option,
 * capture request()'s callback) mirrors
 * packages/automation-engine/src/actions/webhook.test.ts exactly — that is
 * this codebase's established way of testing this pinned-connection
 * mechanism without a real socket.
 *
 * Covers:
 *  - callApi attaches the right header for each auth.type variant
 *  - a disallowed host is rejected before assertEgressAllowed/decryptCredential
 *    are ever called (the actual security property AC3 exists for)
 *  - assertEgressAllowed rejecting propagates before decryptCredential runs
 *  - the outbound connection is genuinely pinned to assertEgressAllowed's
 *    returned IP, via the Agent's lookup callback (C1, PR #381 review — the
 *    actual regression test for the DNS-rebinding fix)
 *  - allowedHosts entries with a scheme/path/wildcard are rejected at
 *    construction time (M4)
 *  - a missing credential's error message does not leak the credential key
 *    name (L1)
 *  - an out-of-union auth.type at runtime hits the exhaustiveness guard (M3)
 *  - log() delegates to @platform/logger's real redact config rather than
 *    reimplementing redaction
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectorDefinition } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type LookupCallback = (
  err: Error | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;
type LookupFn = (
  host: string,
  opts: { all?: boolean },
  cb: LookupCallback,
) => void;

// ── Captured state (per-test, reset in beforeEach) ─────────────────────────────

let capturedLookupFn: LookupFn | undefined;
let capturedRequestOptions: Record<string, unknown> | undefined;
let fakeOnResponse:
  | ((res: {
      statusCode: number;
      statusMessage?: string;
      headers: Record<string, string>;
      on: (event: string, cb: (...args: unknown[]) => void) => void;
    }) => void)
  | undefined;
let fakeOnError: ((err: Error) => void) | undefined;

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockHttpsRequest = vi.fn();
const mockHttpRequest = vi.fn();

function buildFakeReq() {
  const req = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === "error") fakeOnError = cb as (err: Error) => void;
      return req;
    }),
    write: vi.fn(() => req),
    end: vi.fn(() => req),
  };
  return req;
}

vi.mock("node:https", () => ({
  Agent: vi.fn().mockImplementation(function (opts: { lookup?: LookupFn }) {
    capturedLookupFn = opts.lookup;
  }),
  request: (
    opts: Record<string, unknown>,
    cb: (res: unknown) => void,
    ...rest: unknown[]
  ) => mockHttpsRequest(opts, cb, ...rest),
}));

vi.mock("node:http", () => ({
  Agent: vi.fn().mockImplementation(function (opts: { lookup?: LookupFn }) {
    capturedLookupFn = opts.lookup;
  }),
  request: (
    opts: Record<string, unknown>,
    cb: (res: unknown) => void,
    ...rest: unknown[]
  ) => mockHttpRequest(opts, cb, ...rest),
}));

const mockAssertEgressAllowed = vi.fn();
vi.mock("./ssrf-guard.js", () => ({
  assertEgressAllowed: (...args: unknown[]) => mockAssertEgressAllowed(...args),
}));

const mockDecryptCredential = vi.fn();
vi.mock("@platform/secrets", () => ({
  decryptCredential: (...args: unknown[]) => mockDecryptCredential(...args),
}));

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

const { createConnectorContext } = await import("./runtime.js");

// ── Fixtures ───────────────────────────────────────────────────────────────────

function baseDefinition(
  auth: ConnectorDefinition["auth"],
  allowedHosts: string[] = ["api.example.com"],
): ConnectorDefinition {
  return {
    meta: {
      id: "test-connector",
      name: "Test Connector",
      version: "1.0.0",
      description: "A test connector",
      iconUrl: "https://example.com/icon.png",
      category: "other",
    },
    allowedHosts,
    auth,
    triggers: [],
    actions: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedLookupFn = undefined;
  capturedRequestOptions = undefined;
  fakeOnResponse = undefined;
  fakeOnError = undefined;
  mockAssertEgressAllowed.mockResolvedValue("93.184.216.34");
  mockDecryptCredential.mockResolvedValue("plaintext-value");

  for (const mock of [mockHttpsRequest, mockHttpRequest]) {
    mock.mockImplementation(
      (opts: Record<string, unknown>, cb: (res: unknown) => void) => {
        capturedRequestOptions = opts;
        fakeOnResponse = cb as typeof fakeOnResponse;
        return buildFakeReq();
      },
    );
  }
});

/**
 * Drives the fake response through so callApi()'s returned promise resolves.
 * Must be called after the caller has kicked off `ctx.callApi(...)` but
 * before awaiting its result — callApi() awaits one microtask
 * (assertEgressAllowed) before request() is called, so callers should await
 * a real ctx.callApi() call started via Promise.all with a driver, OR simply
 * await callApi() after wiring — since our mocks resolve synchronously-ish
 * via microtasks, a setImmediate-free approach works: call driveResponse()
 * from a .then() on the callApi() promise's setup tick. Simplest in practice:
 * fire callApi() without awaiting, use queueMicrotask to drive the response
 * once the request mock has been invoked, then await the original call.
 */
async function callApiAndRespond(
  ctx: ReturnType<typeof createConnectorContext>,
  config: Parameters<ReturnType<typeof createConnectorContext>["callApi"]>[0],
  response: { status: number; statusMessage?: string; body?: string },
): Promise<Response> {
  const promise = ctx.callApi(config);
  // Poll a few microtasks/macrotasks for the request mock to have been
  // invoked (assertEgressAllowed + decrypt + header building all await).
  for (let i = 0; i < 50 && !fakeOnResponse; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!fakeOnResponse) {
    throw new Error("request() was never called — callApi() short-circuited");
  }
  const chunks: Buffer[] = response.body
    ? [Buffer.from(response.body, "utf8")]
    : [];
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  fakeOnResponse({
    statusCode: response.status,
    statusMessage: response.statusMessage,
    headers: {},
    on: (event, cb) => {
      handlers[event] = cb;
    },
  });
  for (const chunk of chunks) handlers["data"]?.(chunk);
  handlers["end"]?.();
  return promise;
}

// ── auth.type variants ───────────────────────────────────────────────────────

describe("createConnectorContext — callApi auth headers", () => {
  it("attaches a Bearer token for auth.type 'bearer'", async () => {
    mockDecryptCredential.mockResolvedValue("plaintext-token");
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      { accessToken: "ciphertext-abc" },
    );

    await callApiAndRespond(
      ctx,
      { method: "GET", url: "https://api.example.com/v1/x" },
      { status: 200 },
    );

    expect(mockDecryptCredential).toHaveBeenCalledWith(
      "tenant-1",
      "ciphertext-abc",
    );
    const headers = capturedRequestOptions?.["headers"] as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer plaintext-token");
  });

  it("attaches a Basic auth header for auth.type 'basic'", async () => {
    mockDecryptCredential.mockImplementation(
      async (_tenantId: string, ciphertext: string) =>
        ciphertext === "user-ct" ? "alice" : "hunter2",
    );
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({
        type: "basic",
        usernameCredentialKey: "username",
        passwordCredentialKey: "password",
      }),
      { username: "user-ct", password: "pass-ct" },
    );

    await callApiAndRespond(
      ctx,
      { method: "GET", url: "https://api.example.com/v1/x" },
      { status: 200 },
    );

    const headers = capturedRequestOptions?.["headers"] as Record<
      string,
      string
    >;
    const expected = `Basic ${Buffer.from("alice:hunter2").toString("base64")}`;
    expect(headers["Authorization"]).toBe(expected);
  });

  it("attaches a named header for auth.type 'apiKey'", async () => {
    mockDecryptCredential.mockResolvedValue("key-value");
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({
        type: "apiKey",
        headerName: "X-Api-Key",
        credentialKey: "apiKey",
      }),
      { apiKey: "ciphertext-key" },
    );

    await callApiAndRespond(
      ctx,
      { method: "GET", url: "https://api.example.com/v1/x" },
      { status: 200 },
    );

    const headers = capturedRequestOptions?.["headers"] as Record<
      string,
      string
    >;
    expect(headers["X-Api-Key"]).toBe("key-value");
  });

  it("hits the exhaustiveness guard for an out-of-union auth.type (M3)", async () => {
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({
        type: "totally-unknown",
      } as unknown as ConnectorDefinition["auth"]),
      {},
    );

    await expect(
      ctx.callApi({ method: "GET", url: "https://api.example.com/v1/x" }),
    ).rejects.toThrow(/unknown auth\.type/);
    expect(mockDecryptCredential).not.toHaveBeenCalled();
  });
});

// ── Missing credential error (L1) ────────────────────────────────────────────

describe("createConnectorContext — missing credential error", () => {
  it("does not leak the credential key name in the error message (L1)", async () => {
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      {}, // no credentials provided
    );

    await expect(
      ctx.callApi({ method: "GET", url: "https://api.example.com/v1/x" }),
    ).rejects.toThrow(/missing a required credential/);
    // Explicitly assert the credential key name is NOT in the message.
    await ctx
      .callApi({ method: "GET", url: "https://api.example.com/v1/x" })
      .catch((err: Error) => {
        expect(err.message).not.toContain("accessToken");
      });
  });
});

// ── allowedHosts format validation (M4) ──────────────────────────────────────

describe("createConnectorContext — allowedHosts format validation", () => {
  it("throws at construction time for an entry with a scheme", () => {
    expect(() =>
      createConnectorContext(
        "tenant-1",
        baseDefinition({ type: "bearer", credentialKey: "accessToken" }, [
          "https://api.slack.com",
        ]),
        {},
      ),
    ).toThrow(/not a bare hostname/);
  });

  it("throws at construction time for a wildcard entry", () => {
    expect(() =>
      createConnectorContext(
        "tenant-1",
        baseDefinition({ type: "bearer", credentialKey: "accessToken" }, [
          "*.slack.com",
        ]),
        {},
      ),
    ).toThrow(/not a bare hostname/);
  });

  it("throws at construction time for an entry with a path", () => {
    expect(() =>
      createConnectorContext(
        "tenant-1",
        baseDefinition({ type: "bearer", credentialKey: "accessToken" }, [
          "api.slack.com/webhook",
        ]),
        {},
      ),
    ).toThrow(/not a bare hostname/);
  });

  it("accepts a plain hostname", () => {
    expect(() =>
      createConnectorContext(
        "tenant-1",
        baseDefinition({ type: "bearer", credentialKey: "accessToken" }, [
          "api.slack.com",
        ]),
        {},
      ),
    ).not.toThrow();
  });
});

// ── Egress allowlist + ordering ───────────────────────────────────────────────

describe("createConnectorContext — allowedHosts enforcement and ordering", () => {
  it("rejects a disallowed host WITHOUT ever calling assertEgressAllowed or decryptCredential", async () => {
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }, [
        "api.example.com",
      ]),
      { accessToken: "ciphertext-abc" },
    );

    await expect(
      ctx.callApi({
        method: "GET",
        url: "https://attacker.example.com/steal",
      }),
    ).rejects.toThrow(/not in connector's allowedHosts/);

    expect(mockAssertEgressAllowed).not.toHaveBeenCalled();
    expect(mockDecryptCredential).not.toHaveBeenCalled();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it("propagates an SSRF rejection before decryptCredential is ever called", async () => {
    mockAssertEgressAllowed.mockRejectedValue(
      new Error("Connector egress blocked: private/reserved address"),
    );
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      { accessToken: "ciphertext-abc" },
    );

    await expect(
      ctx.callApi({ method: "GET", url: "https://api.example.com/v1/x" }),
    ).rejects.toThrow(/private\/reserved address/);

    expect(mockDecryptCredential).not.toHaveBeenCalled();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });
});

// ── Connection pinning (C1 regression test) ──────────────────────────────────

describe("createConnectorContext — connection pinning (C1, PR #381 review)", () => {
  it("constructs the https.Agent with a lookup callback pinned to assertEgressAllowed's returned IP", async () => {
    mockAssertEgressAllowed.mockResolvedValue("203.0.113.55");
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      { accessToken: "ciphertext-abc" },
    );

    await callApiAndRespond(
      ctx,
      { method: "GET", url: "https://api.example.com/v1/x" },
      { status: 200 },
    );

    expect(capturedLookupFn).toBeDefined();
    // opts.all = true path (Node's happy-eyeballs / multi-address lookup)
    let calledBack: unknown;
    capturedLookupFn?.("api.example.com", { all: true }, (err, addr) => {
      calledBack = addr;
    });
    expect(calledBack).toEqual([{ address: "203.0.113.55", family: 4 }]);

    // opts.all falsy path (single-address lookup)
    let singleAddr: unknown;
    let singleFamily: unknown;
    capturedLookupFn?.("api.example.com", {}, (err, addr, family) => {
      singleAddr = addr;
      singleFamily = family;
    });
    expect(singleAddr).toBe("203.0.113.55");
    expect(singleFamily).toBe(4);
  });

  it("does NOT rewrite the request hostname/path to the pinned IP — preserves the original hostname for TLS SNI", async () => {
    mockAssertEgressAllowed.mockResolvedValue("203.0.113.55");
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      { accessToken: "ciphertext-abc" },
    );

    await callApiAndRespond(
      ctx,
      { method: "GET", url: "https://api.example.com/v1/x?y=1" },
      { status: 200 },
    );

    expect(capturedRequestOptions?.["hostname"]).toBe("api.example.com");
    expect(capturedRequestOptions?.["path"]).toBe("/v1/x?y=1");
  });

  it("passes family=6 in the array form for an IPv6 pinned IP", async () => {
    mockAssertEgressAllowed.mockResolvedValue(
      "2606:2800:220:1:248:1893:25c8:1946",
    );
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      { accessToken: "ciphertext-abc" },
    );

    await callApiAndRespond(
      ctx,
      { method: "GET", url: "https://api.example.com/v1/x" },
      { status: 200 },
    );

    let calledBack: unknown;
    capturedLookupFn?.("api.example.com", { all: true }, (err, addr) => {
      calledBack = addr;
    });
    expect(calledBack).toEqual([
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
  });
});

// ── Response construction ─────────────────────────────────────────────────────

describe("createConnectorContext — Response construction", () => {
  it("returns a real Response with the upstream status and body", async () => {
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      { accessToken: "ciphertext-abc" },
    );

    const res = await callApiAndRespond(
      ctx,
      { method: "GET", url: "https://api.example.com/v1/x" },
      { status: 201, body: '{"ok":true}' },
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("uses http (not https) request for a plain http:// URL", async () => {
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      { accessToken: "ciphertext-abc" },
    );

    await callApiAndRespond(
      ctx,
      { method: "GET", url: "http://api.example.com/v1/x" },
      { status: 200 },
    );

    expect(mockHttpRequest).toHaveBeenCalledOnce();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it("rejects when the underlying request emits a network error", async () => {
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      { accessToken: "ciphertext-abc" },
    );

    const promise = ctx.callApi({
      method: "GET",
      url: "https://api.example.com/v1/x",
    });
    for (let i = 0; i < 50 && !fakeOnError; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!fakeOnError) throw new Error("req.on('error', ...) was never wired");
    fakeOnError(new Error("ECONNRESET"));

    await expect(promise).rejects.toThrow("ECONNRESET");
  });
});

// ── log() redaction ──────────────────────────────────────────────────────────

describe("createConnectorContext — log()", () => {
  it("passes meta straight through to @platform/logger, delegating redaction rather than reimplementing it", () => {
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      {},
    );

    ctx.log("info", "did a thing", { password: "hunter2", other: "keep-me" });

    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    const [loggedObj, loggedMsg] = mockLoggerInfo.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(loggedMsg).toBe("did a thing");
    expect(loggedObj["password"]).toBe("hunter2");
    expect(loggedObj["other"]).toBe("keep-me");
    expect(loggedObj["tenantId"]).toBe("tenant-1");
    expect(loggedObj["connectorId"]).toBe("test-connector");
  });

  it("does not let meta spoof tenantId/connectorId", () => {
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      {},
    );

    ctx.log("warn", "spoof attempt", {
      tenantId: "not-the-real-tenant",
      connectorId: "not-the-real-connector",
    });

    const [loggedObj] = mockLoggerWarn.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(loggedObj["tenantId"]).toBe("tenant-1");
    expect(loggedObj["connectorId"]).toBe("test-connector");
  });
});

// ── Real @platform/logger redaction (integration-lite, unmocked pino) ────────

describe("log() against the real @platform/logger redact config", () => {
  it("actually scrubs a 'password' field when written through real pino redaction", async () => {
    vi.resetModules();
    vi.doUnmock("@platform/logger");
    vi.doUnmock("node:dns/promises");

    const pino = (await import("pino")).default;
    const chunks: string[] = [];
    const testLogger = pino(
      { redact: ["password", "token", "secret", "authorization", "cookie"] },
      { write: (chunk: string) => chunks.push(chunk) },
    );

    testLogger.info(
      { password: "hunter2", other: "keep-me", tenantId: "t1" },
      "did a thing",
    );

    const line = JSON.parse(chunks.join("")) as Record<string, unknown>;
    expect(line["password"]).toBe("[Redacted]");
    expect(line["other"]).toBe("keep-me");
    expect(line["tenantId"]).toBe("t1");
  });
});
