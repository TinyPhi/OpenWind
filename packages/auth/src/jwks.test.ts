import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@platform/config", () => ({
  env: {
    ZITADEL_ISSUER: "https://zitadel.example.com",
    ZITADEL_AUDIENCE: "platform-api",
    JWT_MAX_TOKEN_AGE_SECONDS: 900,
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockCreateRemoteJWKSet = vi.fn(() => ({}));
const mockJwtVerify = vi.fn();
vi.mock("jose", () => ({
  createRemoteJWKSet: (...args: unknown[]) => mockCreateRemoteJWKSet(...args),
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
}));

// verifyJwtForIssuer's tests below use fake .example.com issuer hostnames
// that don't actually resolve -- without this mock, the real SSRF guard
// (real DNS lookups) would block every one of them and each test would pay
// a real DNS-timeout's worth of wall-clock time. Defaults to allowing
// everything; the guard's own enforcement is exercised by the dedicated
// tests further down that override this mock to reject.
const mockAssertExternalIssuerEgressAllowed = vi.fn(() => Promise.resolve());
vi.mock("./ssrf-guard.js", () => ({
  assertExternalIssuerEgressAllowed: (...args: unknown[]) =>
    mockAssertExternalIssuerEgressAllowed(...args),
}));

const {
  extractAuthContext,
  verifyJwt,
  verifyJwtWithAudience,
  verifyJwtForIssuer,
} = await import("./jwks.js");
import type { ZitadelClaims } from "./types.js";
import type { JWTPayload } from "jose";

type Claims = JWTPayload & ZitadelClaims;

const BASE_CLAIMS: Claims = {
  sub: "user-123",
  iss: "https://zitadel.example.com",
  aud: ["platform-api"],
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  email: "alice@example.com",
  "urn:zitadel:iam:user:resourceowner:id": "tenant-abc",
  "urn:zitadel:iam:org:project:roles": {
    agent: { "tenant-abc": "tenant-abc" },
    admin: { "tenant-abc": "tenant-abc" },
  },
};

describe("extractAuthContext", () => {
  it("extracts userId, tenantId, roles and email from valid claims", () => {
    const result = extractAuthContext(BASE_CLAIMS);

    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.tenantId).toBe("tenant-abc");
    expect(result?.email).toBe("alice@example.com");
    expect(result?.roles).toContain("agent");
    expect(result?.roles).toContain("admin");
  });

  it("returns null when sub is missing", () => {
    const claims: Claims = { ...BASE_CLAIMS, sub: undefined };
    expect(extractAuthContext(claims)).toBeNull();
  });

  it("returns null when org id claim is missing", () => {
    const claims: Claims = {
      ...BASE_CLAIMS,
      "urn:zitadel:iam:user:resourceowner:id": undefined,
    };
    expect(extractAuthContext(claims)).toBeNull();
  });

  it("returns empty roles array when project roles claim is absent", () => {
    const claims: Claims = {
      ...BASE_CLAIMS,
      "urn:zitadel:iam:org:project:roles": undefined,
    };
    const result = extractAuthContext(claims);
    expect(result?.roles).toEqual([]);
  });

  it("returns empty string for email when claim is absent", () => {
    const claims: Claims = { ...BASE_CLAIMS, email: undefined };
    const result = extractAuthContext(claims);
    expect(result?.email).toBe("");
  });
});

// #3: audience validation must always be enforced (ZITADEL_AUDIENCE is a
// required, non-empty config value — see packages/config/src/env.ts).
describe("verifyJwt", () => {
  it("always passes the configured audience to jose's jwtVerify", async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: BASE_CLAIMS });

    await verifyJwt("some.jwt.token");

    expect(mockJwtVerify).toHaveBeenCalledWith(
      "some.jwt.token",
      expect.anything(),
      expect.objectContaining({ audience: "platform-api" }),
    );
  });

  it("uses clockTolerance of 5 seconds — not 30 (#255)", async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: BASE_CLAIMS });

    await verifyJwt("some.jwt.token");

    expect(mockJwtVerify).toHaveBeenCalledWith(
      "some.jwt.token",
      expect.anything(),
      expect.objectContaining({ clockTolerance: 5 }),
    );
  });

  it("returns null when jwtVerify rejects (e.g. audience mismatch)", async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error("audience mismatch"));

    const result = await verifyJwt("some.jwt.token");

    expect(result).toBeNull();
  });

  // ADR-012 Phase G, spec R6 — the regular human-login JWT path must NOT
  // gain a new max-age restriction; only the third-party acting-person path
  // (verifyJwtWithAudience) opts into it.
  it("does NOT pass maxTokenAge — only verifyJwtWithAudience does", async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: BASE_CLAIMS });

    await verifyJwt("some.jwt.token");

    expect(mockJwtVerify).toHaveBeenCalledWith(
      "some.jwt.token",
      expect.anything(),
      expect.not.objectContaining({ maxTokenAge: expect.anything() }),
    );
  });
});

// ADR-012 Phase G, spec R6 — third-party acting-person token freshness,
// independent of Zitadel's own exp-based expiry.
describe("verifyJwtWithAudience", () => {
  it("passes the configured JWT_MAX_TOKEN_AGE_SECONDS as jose's maxTokenAge", async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: BASE_CLAIMS });

    await verifyJwtWithAudience("some.jwt.token", "third-party-client-id");

    expect(mockJwtVerify).toHaveBeenCalledWith(
      "some.jwt.token",
      expect.anything(),
      expect.objectContaining({ maxTokenAge: 900 }),
    );
  });

  it("returns null when jose rejects for staleness (iat too old)", async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error("iat too far in the past"));

    const result = await verifyJwtWithAudience(
      "stale.jwt.token",
      "third-party-client-id",
    );

    expect(result).toBeNull();
  });
});

describe("getJwks (#262)", () => {
  it("creates the remote JWKS set with a 1-hour cacheMaxAge", async () => {
    mockJwtVerify.mockResolvedValueOnce({ payload: BASE_CLAIMS });
    await verifyJwt("trigger-jwks-init");

    expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ cacheMaxAge: 60 * 60 * 1000 }),
    );
  });
});

// Third-party API key external-org mapping (docs/specs/third-party-key-external-org-mapping.md,
// Phase 1 T2/T3a) -- verifies JWKS resolution generalizes to any issuer via
// OIDC discovery, not just the platform's hardcoded ZITADEL_ISSUER/
// ZITADEL_JWKS_URL. Not yet wired to any call site (Phase 2 does that) --
// these tests exercise the function directly.
describe("verifyJwtForIssuer (#docs/specs/third-party-key-external-org-mapping.md)", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    // mockCreateRemoteJWKSet is shared with the getJwks()/verifyJwt tests
    // above and accumulates calls across the whole file (nothing globally
    // clears mocks between tests) -- clear it so each test here only sees
    // calls it triggered itself.
    mockCreateRemoteJWKSet.mockClear();
    mockAssertExternalIssuerEgressAllowed.mockReset();
    mockAssertExternalIssuerEgressAllowed.mockResolvedValue(undefined);
  });

  // Security-review finding (docs/specs/third-party-key-external-org-mapping.md
  // Phase 2): the discovery/JWKS fetches must actually run through the SSRF
  // guard, not just have it imported unused.
  it("runs the issuer through the SSRF guard before fetching its discovery document", async () => {
    mockDiscovery(
      "https://ssrf-guard-test.example.com",
      "https://ssrf-guard-test.example.com/jwks",
    );
    mockJwtVerify.mockResolvedValueOnce({ payload: { sub: "user-1" } });

    await verifyJwtForIssuer(
      "some.jwt",
      "https://ssrf-guard-test.example.com",
      "client-xyz",
    );

    expect(mockAssertExternalIssuerEgressAllowed).toHaveBeenCalledWith(
      "https://ssrf-guard-test.example.com",
    );
  });

  it("also runs the discovery document's own jwks_uri through the SSRF guard before using it", async () => {
    mockDiscovery(
      "https://ssrf-guard-jwks-uri-test.example.com",
      "https://attacker-controlled.example.com/jwks",
    );
    mockJwtVerify.mockResolvedValueOnce({ payload: { sub: "user-1" } });

    await verifyJwtForIssuer(
      "some.jwt",
      "https://ssrf-guard-jwks-uri-test.example.com",
      "client-xyz",
    );

    expect(mockAssertExternalIssuerEgressAllowed).toHaveBeenCalledWith(
      "https://attacker-controlled.example.com/jwks",
    );
  });

  it("returns null (fails closed) when the SSRF guard rejects the issuer, never fetching discovery", async () => {
    mockAssertExternalIssuerEgressAllowed.mockRejectedValueOnce(
      new Error("Issuer host resolves to a private/reserved address"),
    );

    const result = await verifyJwtForIssuer(
      "some.jwt",
      "https://blocked-issuer-test.example.com",
      "client-xyz",
    );

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null (fails closed) when the SSRF guard rejects the discovery document's jwks_uri", async () => {
    mockDiscovery(
      "https://blocked-jwks-uri-test.example.com",
      "http://169.254.169.254/jwks",
    );
    mockAssertExternalIssuerEgressAllowed.mockImplementation((url: string) =>
      url.includes("169.254.169.254")
        ? Promise.reject(new Error("blocked"))
        : Promise.resolve(),
    );

    const result = await verifyJwtForIssuer(
      "some.jwt",
      "https://blocked-jwks-uri-test.example.com",
      "client-xyz",
    );

    expect(result).toBeNull();
    expect(mockCreateRemoteJWKSet).not.toHaveBeenCalled();
  });

  function mockDiscovery(issuer: string, jwksUri: string) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ jwks_uri: jwksUri }),
    });
  }

  // NOTE: the JWKS-per-issuer cache is module-level state that persists
  // across tests in this file (no vi.resetModules() between them) -- each
  // test below uses its own unique issuer hostname so a cache hit from an
  // earlier test can never mask what THIS test is actually asserting.

  it("fetches the issuer's own OIDC discovery document to find its jwks_uri", async () => {
    mockDiscovery(
      "https://fetch-test.example.com",
      "https://fetch-test.example.com/jwks",
    );
    mockJwtVerify.mockResolvedValueOnce({ payload: { sub: "user-1" } });

    await verifyJwtForIssuer(
      "some.jwt",
      "https://fetch-test.example.com",
      "client-xyz",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://fetch-test.example.com/.well-known/openid-configuration",
    );
    expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
      new URL("https://fetch-test.example.com/jwks"),
      expect.objectContaining({ cacheMaxAge: 60 * 60 * 1000 }),
    );
  });

  it("passes issuer, audience, clockTolerance=5, and maxTokenAge to jose's jwtVerify", async () => {
    mockDiscovery(
      "https://verify-args-test.example.com",
      "https://verify-args-test.example.com/jwks",
    );
    mockJwtVerify.mockResolvedValueOnce({ payload: { sub: "user-1" } });

    await verifyJwtForIssuer(
      "some.jwt",
      "https://verify-args-test.example.com",
      "client-xyz",
    );

    expect(mockJwtVerify).toHaveBeenCalledWith(
      "some.jwt",
      expect.anything(),
      expect.objectContaining({
        issuer: "https://verify-args-test.example.com",
        audience: "client-xyz",
        clockTolerance: 5,
        maxTokenAge: 900,
      }),
    );
  });

  it("caches the JWKS getter per-issuer -- a second call for the same issuer does not re-fetch discovery", async () => {
    mockDiscovery(
      "https://cache-test.example.com",
      "https://cache-test.example.com/jwks",
    );
    mockJwtVerify.mockResolvedValue({ payload: { sub: "user-1" } });

    await verifyJwtForIssuer(
      "token-1",
      "https://cache-test.example.com",
      "client-xyz",
    );
    await verifyJwtForIssuer(
      "token-2",
      "https://cache-test.example.com",
      "client-xyz",
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockCreateRemoteJWKSet).toHaveBeenCalledTimes(1);
  });

  it("resolves a distinct JWKS getter for a different issuer -- no cross-contamination", async () => {
    mockDiscovery(
      "https://issuer-a-test.example.com",
      "https://issuer-a-test.example.com/jwks",
    );
    mockDiscovery(
      "https://issuer-b-test.example.com",
      "https://issuer-b-test.example.com/jwks",
    );
    mockJwtVerify.mockResolvedValue({ payload: { sub: "user-1" } });

    await verifyJwtForIssuer(
      "token-a",
      "https://issuer-a-test.example.com",
      "client-a",
    );
    await verifyJwtForIssuer(
      "token-b",
      "https://issuer-b-test.example.com",
      "client-b",
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockCreateRemoteJWKSet).toHaveBeenCalledTimes(2);
    expect(mockCreateRemoteJWKSet).toHaveBeenNthCalledWith(
      1,
      new URL("https://issuer-a-test.example.com/jwks"),
      expect.anything(),
    );
    expect(mockCreateRemoteJWKSet).toHaveBeenNthCalledWith(
      2,
      new URL("https://issuer-b-test.example.com/jwks"),
      expect.anything(),
    );
  });

  // docs/specs/third-party-key-external-org-mapping.md §B B3 -- unbounded
  // growth of the per-issuer cache would become a DoS surface once real
  // admin-set external_issuer values flow through it. Proves eviction
  // actually happens once the cap is exceeded, and that the evicted issuer
  // triggers a fresh discovery fetch on its next use (a stale/leaked entry
  // would instead show no new fetch).
  it("evicts the least-recently-used issuer once the cache exceeds its bound", async () => {
    // MAX_CACHED_EXTERNAL_ISSUERS is 50 and not exported -- exercised via
    // observable behavior (eviction happens, not the exact constant) rather
    // than reaching into module-private state.
    const CAP = 50;
    for (let i = 0; i < CAP; i++) {
      mockDiscovery(
        `https://lru-test-${i}.example.com`,
        `https://lru-test-${i}.example.com/jwks`,
      );
    }
    mockJwtVerify.mockResolvedValue({ payload: { sub: "user-1" } });
    for (let i = 0; i < CAP; i++) {
      await verifyJwtForIssuer(
        "token",
        `https://lru-test-${i}.example.com`,
        "client-xyz",
      );
    }
    // Filling the cache to exactly its cap must not have evicted anything
    // yet -- issuer 0 (the oldest) still resolves from cache, no new fetch.
    mockFetch.mockClear();
    await verifyJwtForIssuer(
      "token",
      "https://lru-test-0.example.com",
      "client-xyz",
    );
    expect(mockFetch).not.toHaveBeenCalled();

    // One more, distinct issuer pushes the cache over its cap -- issuer 1
    // (now the actual least-recently-used, since issuer 0 was just touched
    // above) must be evicted, forcing a fresh discovery fetch next time.
    mockDiscovery(
      "https://lru-test-overflow.example.com",
      "https://lru-test-overflow.example.com/jwks",
    );
    await verifyJwtForIssuer(
      "token",
      "https://lru-test-overflow.example.com",
      "client-xyz",
    );

    mockFetch.mockClear();
    mockDiscovery(
      "https://lru-test-1.example.com",
      "https://lru-test-1.example.com/jwks",
    );
    await verifyJwtForIssuer(
      "token",
      "https://lru-test-1.example.com",
      "client-xyz",
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns null when the issuer's discovery document is unreachable", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await verifyJwtForIssuer(
      "some.jwt",
      "https://down-test.example.com",
      "client-xyz",
    );

    expect(result).toBeNull();
  });

  // Security-review finding: discovery response must be Zod-validated, not
  // trusted via a bare type assertion -- fails closed on a malformed/
  // malicious document instead of a confusing new URL(undefined) crash.
  it("returns null when the discovery document is missing jwks_uri", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ issuer: "https://malformed-test.example.com" }),
    });

    const result = await verifyJwtForIssuer(
      "some.jwt",
      "https://malformed-test.example.com",
      "client-xyz",
    );

    expect(result).toBeNull();
    expect(mockCreateRemoteJWKSet).not.toHaveBeenCalled();
  });

  it("returns null when jose rejects (bad signature, issuer mismatch, etc.)", async () => {
    mockDiscovery(
      "https://reject-test.example.com",
      "https://reject-test.example.com/jwks",
    );
    mockJwtVerify.mockRejectedValueOnce(
      new Error("signature verification failed"),
    );

    const result = await verifyJwtForIssuer(
      "bad.jwt",
      "https://reject-test.example.com",
      "client-xyz",
    );

    expect(result).toBeNull();
  });
});
