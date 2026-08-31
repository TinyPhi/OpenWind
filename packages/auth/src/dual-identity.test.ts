import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthContext } from "./types.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockVerifyJwtWithAudience = vi.fn();
vi.mock("./jwks.js", () => ({
  verifyJwtWithAudience: (...args: unknown[]) =>
    mockVerifyJwtWithAudience(...args),
}));

// Row returned for the tenant-scoped api_keys lookup — undefined means "no
// row" (key doesn't exist / already revoked, filtered by the WHERE clause).
let mockKeyRow: { oidcClientId: string | null } | undefined = {
  oidcClientId: "client-abc",
};

const mockDbSelect = vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({
      limit: vi.fn(() => Promise.resolve(mockKeyRow ? [mockKeyRow] : [])),
    })),
  })),
}));

vi.mock("@platform/db", () => ({
  apiKeys: {
    id: "api_keys.id",
    oidcClientId: "api_keys.oidc_client_id",
    revokedAt: "api_keys.revoked_at",
  },
  withTenantContext: vi.fn((_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({ select: mockDbSelect }),
  ),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...conds) => ({ op: "and", conds })),
  isNull: vi.fn((col) => ({ col, op: "isNull" })),
}));

const { requireActingPerson, ACTING_PERSON_TOKEN_MAX_AGE_MINUTES } =
  await import("./dual-identity.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const API_KEY_AUTH: AuthContext = {
  userId: "apikey:11111111-1111-1111-1111-111111111111",
  tenantId: "tenant-abc",
  roles: ["entity:ticket:create", "entity:ticket:read"],
  email: "",
  displayName: "API Key 11111111",
  orgId: "org-ccc",
};

const HUMAN_AUTH: AuthContext = {
  userId: "human-user-1",
  tenantId: "tenant-abc",
  roles: ["agent"],
  email: "alice@example.com",
  displayName: "Alice",
  orgId: "org-ccc",
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function makeApp(auth: AuthContext) {
  const app = new Hono();
  app.get(
    "/test",
    async (c, next) => {
      c.set("auth", auth);
      await next();
    },
    requireActingPerson(),
    (c) => c.json({ ok: true, actingPerson: c.get("actingPerson") }),
  );
  return app;
}

async function get(app: Hono, personToken?: string) {
  const headers: Record<string, string> = personToken
    ? { "X-Acting-Person-Token": personToken }
    : {};
  return app.request("/test", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockKeyRow = { oidcClientId: "client-abc" };
  mockVerifyJwtWithAudience.mockResolvedValue({
    sub: "person-1",
    email: "person1@example.com",
    name: "Person One",
    iat: nowSeconds(),
    "urn:zitadel:iam:user:resourceowner:id": "org-ccc",
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("requireActingPerson", () => {
  it("short-circuits when actingPerson is already pre-populated (test-fixture injection), same precedent as requireAuth", async () => {
    const app = new Hono();
    app.get(
      "/test",
      async (c, next) => {
        c.set("auth", API_KEY_AUTH);
        c.set("actingPerson", {
          userId: "pre-set-person",
          email: "preset@example.com",
          displayName: "Pre Set",
          orgId: "org-preset",
        });
        await next();
      },
      requireActingPerson(),
      (c) => c.json({ ok: true, actingPerson: c.get("actingPerson") }),
    );
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actingPerson: { userId: string } };
    expect(body.actingPerson.userId).toBe("pre-set-person");
    // Never touches token verification — the whole point of the bypass.
    expect(mockVerifyJwtWithAudience).not.toHaveBeenCalled();
  });

  it("rejects a request with no acting-person token header", async () => {
    const res = await get(makeApp(API_KEY_AUTH));
    expect(res.status).toBe(401);
  });

  it("rejects when the underlying auth is a human session, not an API key", async () => {
    const res = await get(makeApp(HUMAN_AUTH), "some-token");
    expect(res.status).toBe(401);
    // Never even reaches the token-verification step for a non-API-key auth.
    expect(mockVerifyJwtWithAudience).not.toHaveBeenCalled();
  });

  it("rejects when the presented key has no registered Zitadel Client ID", async () => {
    mockKeyRow = { oidcClientId: null };
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(401);
    expect(mockVerifyJwtWithAudience).not.toHaveBeenCalled();
  });

  it("rejects when the presented key is not found (e.g. revoked)", async () => {
    mockKeyRow = undefined;
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(401);
    expect(mockVerifyJwtWithAudience).not.toHaveBeenCalled();
  });

  it("verifies the person token against the key's own registered Client ID", async () => {
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(200);
    expect(mockVerifyJwtWithAudience).toHaveBeenCalledWith(
      "some-token",
      "client-abc",
    );
  });

  it("rejects a token that fails verification (bad signature/issuer/expiry/aud)", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue(null);
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(401);
  });

  it("rejects a genuinely valid token minted for a different registered application", async () => {
    // jose's own audience check inside verifyJwtWithAudience is what would
    // reject this in reality (aud doesn't include the presented key's
    // Client ID) — simulated here as verification returning null, exactly
    // like any other aud mismatch.
    mockVerifyJwtWithAudience.mockResolvedValue(null);
    const res = await get(makeApp(API_KEY_AUTH), "token-for-other-app");
    expect(res.status).toBe(401);
  });

  it("accepts a token exactly at the freshness boundary", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue({
      sub: "person-1",
      email: "person1@example.com",
      iat: nowSeconds() - ACTING_PERSON_TOKEN_MAX_AGE_MINUTES * 60 + 1,
      "urn:zitadel:iam:user:resourceowner:id": "org-ccc",
    });
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(200);
  });

  it("rejects a token older than the configured max age, even though not yet expired by iss", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue({
      sub: "person-1",
      email: "person1@example.com",
      iat: nowSeconds() - ACTING_PERSON_TOKEN_MAX_AGE_MINUTES * 60 - 1,
      "urn:zitadel:iam:user:resourceowner:id": "org-ccc",
    });
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(401);
  });

  it("tolerates a minor future clock skew", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue({
      sub: "person-1",
      email: "person1@example.com",
      iat: nowSeconds() + 10,
      "urn:zitadel:iam:user:resourceowner:id": "org-ccc",
    });
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(200);
  });

  it("rejects a token from the future exceeding clock skew tolerance", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue({
      sub: "person-1",
      email: "person1@example.com",
      iat: nowSeconds() + 70,
      "urn:zitadel:iam:user:resourceowner:id": "org-ccc",
    });
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(401);
  });

  it("rejects a token missing iat entirely", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue({
      sub: "person-1",
      email: "person1@example.com",
      "urn:zitadel:iam:user:resourceowner:id": "org-ccc",
    });
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(401);
  });

  // Third-party API key external-org mapping (docs/specs/third-party-key-external-org-mapping.md,
  // Phase 1 T3/T3a) -- a non-Zitadel IdP (e.g. AuthNexus) puts the org id
  // under a plain "org_id" claim instead of Zitadel's namespaced one. The
  // org-match check must accept either claim shape, not just Zitadel's.
  it("accepts a token whose org id is under the plain org_id claim (non-Zitadel IdP shape)", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue({
      sub: "person-1",
      email: "person1@example.com",
      iat: nowSeconds(),
      org_id: "org-ccc",
    });
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(200);
  });

  it("prefers the Zitadel-namespaced org claim over org_id when both are somehow present", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue({
      sub: "person-1",
      email: "person1@example.com",
      iat: nowSeconds(),
      "urn:zitadel:iam:user:resourceowner:id": "org-ccc",
      org_id: "org-different-tenant",
    });
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(200);
  });

  it("rejects a token whose org claim does not match the key's tenant-mapped org", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue({
      sub: "person-1",
      email: "person1@example.com",
      iat: nowSeconds(),
      "urn:zitadel:iam:user:resourceowner:id": "org-different-tenant",
    });
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(401);
  });

  it("rejects a token missing the org claim entirely", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue({
      sub: "person-1",
      email: "person1@example.com",
      iat: nowSeconds(),
    });
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(401);
  });

  it("rejects a token missing sub", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue({
      email: "person1@example.com",
      iat: nowSeconds(),
      "urn:zitadel:iam:user:resourceowner:id": "org-ccc",
    });
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(401);
  });

  it("sets actingPerson context on success, derived from the token's own claims", async () => {
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      actingPerson: { userId: string; email: string; displayName: string };
    };
    expect(body.actingPerson).toEqual({
      userId: "person-1",
      email: "person1@example.com",
      displayName: "Person One",
      orgId: "org-ccc",
    });
  });

  it("falls back to email, then userId, for displayName when name/given/family are absent", async () => {
    mockVerifyJwtWithAudience.mockResolvedValue({
      sub: "person-1",
      email: "person1@example.com",
      iat: nowSeconds(),
      "urn:zitadel:iam:user:resourceowner:id": "org-ccc",
    });
    const res = await get(makeApp(API_KEY_AUTH), "some-token");
    const body = (await res.json()) as {
      actingPerson: { displayName: string };
    };
    expect(body.actingPerson.displayName).toBe("person1@example.com");
  });

  it("produces byte-identical error responses across every distinct failure case (spec R14)", async () => {
    const noHeader = await get(makeApp(API_KEY_AUTH));
    mockKeyRow = { oidcClientId: null };
    const noClientId = await get(makeApp(API_KEY_AUTH), "t");
    mockKeyRow = { oidcClientId: "client-abc" };
    mockVerifyJwtWithAudience.mockResolvedValue(null);
    const badToken = await get(makeApp(API_KEY_AUTH), "t");

    const bodies = await Promise.all(
      [noHeader, noClientId, badToken].map((r) => r.json()),
    );
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(noHeader.status).toBe(401);
    expect(noClientId.status).toBe(401);
    expect(badToken.status).toBe(401);
  });
});
