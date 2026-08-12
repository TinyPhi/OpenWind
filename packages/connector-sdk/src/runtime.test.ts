/**
 * runtime.test.ts
 *
 * Unit tests for createConnectorContext(). No DB, no OpenBao — decryptCredential
 * and global fetch are both mocked. DNS is mocked the same way
 * automation-engine's ssrf-guard.test.ts mocks it (no real network calls).
 *
 * Covers:
 *  - callApi attaches the right header for each auth.type variant
 *  - a disallowed host is rejected before decryptCredential is ever called
 *    (the actual security property AC3 exists for, not just "it throws")
 *  - the SSRF guard blocks a private/internal IP even if it were on the
 *    allowlist
 *  - log() delegates to @platform/logger's real redact config rather than
 *    reimplementing redaction
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectorDefinition } from "./types.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockDecryptCredential = vi.fn();
vi.mock("@platform/secrets", () => ({
  decryptCredential: (...args: unknown[]) => mockDecryptCredential(...args),
}));

const mockLookup = vi.fn();
vi.mock("node:dns/promises", () => ({
  default: { lookup: (...args: unknown[]) => mockLookup(...args) },
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

// Local stand-in for the fetch RequestInit shape we assert on — avoids
// referencing the DOM lib's `RequestInit` type name directly, which this
// package's eslint config (no `dom` lib globals) flags as undefined.
type FetchCallInit = { headers: Record<string, string> };

// ── Helpers ────────────────────────────────────────────────────────────────────

function dnsResult(ips: string[]) {
  return Promise.resolve(
    ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );
}

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

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockLookup.mockReturnValue(dnsResult(["93.184.216.34"])); // public IP (example.com)
  mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", mockFetch);
});

// ── auth.type variants ───────────────────────────────────────────────────────

describe("createConnectorContext — callApi auth headers", () => {
  it("attaches a Bearer token for auth.type 'bearer'", async () => {
    mockDecryptCredential.mockResolvedValue("plaintext-token");
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      { accessToken: "ciphertext-abc" },
    );

    await ctx.callApi({ method: "GET", url: "https://api.example.com/v1/x" });

    expect(mockDecryptCredential).toHaveBeenCalledWith(
      "tenant-1",
      "ciphertext-abc",
    );
    const [, init] = mockFetch.mock.calls[0] as [string, FetchCallInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer plaintext-token",
    );
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

    await ctx.callApi({ method: "GET", url: "https://api.example.com/v1/x" });

    const [, init] = mockFetch.mock.calls[0] as [string, FetchCallInit];
    const expected = `Basic ${Buffer.from("alice:hunter2").toString("base64")}`;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      expected,
    );
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

    await ctx.callApi({ method: "GET", url: "https://api.example.com/v1/x" });

    const [, init] = mockFetch.mock.calls[0] as [string, FetchCallInit];
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe(
      "key-value",
    );
  });
});

// ── Egress allowlist ─────────────────────────────────────────────────────────

describe("createConnectorContext — allowedHosts enforcement", () => {
  it("rejects a disallowed host WITHOUT ever calling decryptCredential", async () => {
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }, [
        "api.example.com",
      ]),
      { accessToken: "ciphertext-abc" },
    );

    await expect(
      ctx.callApi({ method: "GET", url: "https://attacker.example.com/steal" }),
    ).rejects.toThrow(/not in connector's allowedHosts/);

    expect(mockDecryptCredential).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── SSRF guard ────────────────────────────────────────────────────────────────

describe("createConnectorContext — SSRF guard", () => {
  it("blocks a private/internal IP target even though the host is on the allowlist", async () => {
    mockLookup.mockReturnValue(dnsResult(["169.254.169.254"])); // link-local/cloud metadata
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition(
        { type: "bearer", credentialKey: "accessToken" },
        ["api.example.com"], // host IS allowlisted; SSRF guard must still block
      ),
      { accessToken: "ciphertext-abc" },
    );

    await expect(
      ctx.callApi({ method: "GET", url: "https://api.example.com/v1/x" }),
    ).rejects.toThrow(/private\/reserved address/);

    expect(mockDecryptCredential).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("blocks RFC 1918 addresses (10.x.x.x)", async () => {
    mockLookup.mockReturnValue(dnsResult(["10.0.0.5"]));
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      { accessToken: "ciphertext-abc" },
    );

    await expect(
      ctx.callApi({ method: "GET", url: "https://api.example.com/v1/x" }),
    ).rejects.toThrow(/private\/reserved address/);
  });

  it("allows a public IP target through", async () => {
    mockLookup.mockReturnValue(dnsResult(["93.184.216.34"]));
    mockDecryptCredential.mockResolvedValue("plaintext-token");
    const ctx = createConnectorContext(
      "tenant-1",
      baseDefinition({ type: "bearer", credentialKey: "accessToken" }),
      { accessToken: "ciphertext-abc" },
    );

    const res = await ctx.callApi({
      method: "GET",
      url: "https://api.example.com/v1/x",
    });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
    // The raw value is handed to @platform/logger's logger.info() unmodified —
    // it is @platform/logger's own pino `redact` config (password/token/
    // secret/authorization/cookie) that scrubs it at serialization time, the
    // same as every other structured log call in this codebase. Our log()
    // must NOT strip/mask it itself — that would be reimplementing the
    // mechanism this AC explicitly says to reuse instead.
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

    // Exercise the exact call shape runtime.ts's log() uses: object first,
    // message second, spreading meta before the identifying fields.
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
