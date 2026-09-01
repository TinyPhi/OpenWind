/**
 * Isolation tests for third-party API key external-org mapping
 * (docs/specs/third-party-key-external-org-mapping.md, Phase 2 T7).
 *
 * A third-party key can trust acting-person tokens minted by a different IdP
 * than the tenant's primary login IdP (tenants.zitadel_org_id) by carrying
 * its own external_issuer/external_org_id pair. Covers, against real
 * Postgres (no mocks):
 *
 * - creation-time validation (T5): externalOrgId without externalIssuer,
 *   externalIssuer matching the platform's own ZITADEL_ISSUER, externalIssuer
 *   set without externalOrgId, and the happy path — all via the real
 *   createApiKeyHandler route, not a unit-mocked one.
 * - dual-identity verification (T6): requireActingPerson resolves an
 *   external-mapped key's issuer/org independently per row, under RLS,
 *   across two tenants, and the default (non-external) path is unaffected.
 * - R1: existing role-format and default action-format keys (no external
 *   mapping) are untouched by any of the above.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { env } from "@platform/config";
import { db, withTenantContext, apiKeys, tenants } from "@platform/db";
import { hashApiKey, requireActingPerson } from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import { createApiKeyHandler } from "../../src/routes/api-keys/create.js";

const EXTERNAL_ISSUER = "https://auth.external-idp-test.example";

// dual-identity.ts imports verifyJwtForIssuer via a relative "./jwks.js"
// specifier, not through the package's public "@platform/auth" barrel --
// mocking the barrel itself does not intercept that internal import.
// apps/api's vitest.config.ts aliases "@platform/auth" straight to
// packages/auth/src/index.ts, so the relative import inside dual-identity.ts
// resolves to packages/auth/src/jwks.ts -- mock that concrete path directly
// (matching the alias's target directory) while still exercising the REAL
// requireActingPerson end-to-end (real Postgres, real RLS, real create.ts
// route) for everything else.
const mockVerifyJwtForIssuer = vi.fn();
vi.mock("../../../../packages/auth/src/jwks.ts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../../packages/auth/src/jwks.ts",
  );
  return {
    ...actual,
    verifyJwtForIssuer: (...args: unknown[]) => mockVerifyJwtForIssuer(...args),
  };
});

// create.ts's creation-time validation runs externalIssuer through the real
// SSRF guard (real DNS resolution) -- this isolation suite's job is proving
// the real Postgres/RLS behavior, not re-proving SSRF enforcement (already
// covered by packages/auth/src/ssrf-guard.test.ts and this route's own
// create.test.ts unit tests, both with mocked DNS). Mocked to always-allow
// here so this suite isn't flaky/slow against real network DNS, same
// rationale as mocking verifyJwtForIssuer above.
vi.mock("../../../../packages/auth/src/ssrf-guard.ts", () => ({
  assertExternalIssuerEgressAllowed: () => Promise.resolve(undefined),
}));

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000472";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000472";

const mintedKeyIdsA: string[] = [];
const mintedKeyIdsB: string[] = [];

beforeEach(() => {
  mockVerifyJwtForIssuer.mockClear();
});

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "External Org Mapping Test A",
      slug: `external-org-mapping-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "External Org Mapping Test B",
      slug: `external-org-mapping-b-${TENANT_B}`,
    },
  ]);
});

afterAll(async () => {
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(apiKeys).where(inArray(apiKeys.id, mintedKeyIdsA)),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.delete(apiKeys).where(inArray(apiKeys.id, mintedKeyIdsB)),
  );
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

function makeCreateApp(tenantId: string = TENANT_A) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      tenantId,
      userId: "isolation-test-admin",
      roles: ["admin"],
      email: "admin@example.com",
    });
    await next();
  });
  app.post("/", ...createApiKeyHandler);
  return app;
}

// requireIntrospection() exempts sk_-prefixed bearer tokens from live Zitadel
// introspection — same pattern as the mint/reclaim isolation test.
function skHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer sk_isolation_test_bypass",
  };
}

function mintBody(clientId: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "external-org-mapping-test",
    scopes: ["entity:ticket:read"],
    applicationName: "External Org Mapping Test App",
    applicationContactEmail: "ops@external-org-mapping-test.example",
    oidcClientId: clientId,
    ...overrides,
  });
}

describe("POST /api-keys — external-org mapping creation validation (T5, real Postgres)", () => {
  it("mints successfully with a valid externalIssuer + externalOrgId pair", async () => {
    const res = await makeCreateApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("ext-org-mint-happy-1", {
        externalIssuer: EXTERNAL_ISSUER,
        externalOrgId: "external-org-happy-1",
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { id: string; externalIssuer: string; externalOrgId: string };
    };
    mintedKeyIdsA.push(json.data.id);
    expect(json.data.externalIssuer).toBe(EXTERNAL_ISSUER);
    expect(json.data.externalOrgId).toBe("external-org-happy-1");
  });

  it("rejects externalOrgId supplied without externalIssuer (422)", async () => {
    const res = await makeCreateApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("ext-org-mint-orphan-org-1", {
        externalOrgId: "external-org-orphan-1",
      }),
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("rejects externalIssuer that matches the platform's own primary IdP (422)", async () => {
    const res = await makeCreateApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("ext-org-mint-primary-idp-1", {
        externalIssuer: env.ZITADEL_ISSUER,
        externalOrgId: "external-org-primary-1",
      }),
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("rejects a trailing-slash variant of the platform's own primary IdP the same way (normalization)", async () => {
    const res = await makeCreateApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("ext-org-mint-primary-idp-slash-1", {
        externalIssuer: `${env.ZITADEL_ISSUER}/`,
        externalOrgId: "external-org-primary-2",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects externalIssuer set without externalOrgId (422 ORG_MAPPING_REQUIRED)", async () => {
    const res = await makeCreateApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("ext-org-mint-missing-org-1", {
        externalIssuer: EXTERNAL_ISSUER,
      }),
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("ORG_MAPPING_REQUIRED");
  });

  it("rejects externalIssuer/externalOrgId on a role-format (internal) key", async () => {
    const res = await makeCreateApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: JSON.stringify({
        name: "external-org-mapping-role-format-test",
        scopes: ["agent"],
        externalIssuer: EXTERNAL_ISSUER,
        externalOrgId: "external-org-role-format-1",
      }),
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("leaves an existing action-format key with no external mapping untouched (R1 — both columns null)", async () => {
    const res = await makeCreateApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("ext-org-mint-default-1"),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: {
        id: string;
        externalIssuer: string | null;
        externalOrgId: string | null;
      };
    };
    mintedKeyIdsA.push(json.data.id);
    expect(json.data.externalIssuer).toBeNull();
    expect(json.data.externalOrgId).toBeNull();
  });
});

describe("requireActingPerson — external-org mapping verification (T6, real Postgres)", () => {
  async function insertKeyWithMapping(
    tenantId: string,
    overrides: Partial<typeof apiKeys.$inferInsert>,
  ) {
    const [row] = await withTenantContext(tenantId, (tx) =>
      tx
        .insert(apiKeys)
        .values({
          tenantId,
          name: "external-org-mapping-verify-test",
          keyHash: hashApiKey(
            `sk_ext_org_verify_${Math.random().toString(36).slice(2)}`,
          ),
          scopes: ["entity:ticket:read"],
          scopesFormat: "action",
          oidcClientId: `ext-org-verify-client-${Math.random().toString(36).slice(2)}`,
          ...overrides,
        })
        .returning(),
    );
    if (!row) {
      throw new Error("api key insert failed");
    }
    return row;
  }

  function makeVerifyApp(auth: AuthContext) {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.get(
      "/whoami",
      async (c, next) => {
        c.set("auth", auth);
        await next();
      },
      requireActingPerson(),
      (c) => c.json({ actingPerson: c.get("actingPerson") }),
    );
    return app;
  }

  it("verifies an external-mapped key via the issuer-specific path and matches its own externalOrgId, independent of the tenant's primary org", async () => {
    const key = await insertKeyWithMapping(TENANT_A, {
      externalIssuer: EXTERNAL_ISSUER,
      externalOrgId: "external-org-verify-a-1",
    });
    mintedKeyIdsA.push(key.id);

    mockVerifyJwtForIssuer.mockResolvedValueOnce({
      sub: "external-person-1",
      email: "person@example.com",
      iat: Math.floor(Date.now() / 1000),
      org_id: "external-org-verify-a-1",
    });

    const res = await makeVerifyApp({
      userId: `apikey:${key.id}`,
      // Deliberately a DIFFERENT value than externalOrgId — proves the
      // external path never falls back to auth.orgId.
      tenantId: TENANT_A,
      roles: ["entity:ticket:read"],
      email: "",
      displayName: "API Key",
      orgId: "tenant-a-primary-org-unrelated",
    }).request("/whoami", {
      headers: { "X-Acting-Person-Token": "some-token" },
    });

    expect(res.status).toBe(200);
    expect(mockVerifyJwtForIssuer).toHaveBeenCalledWith(
      "some-token",
      EXTERNAL_ISSUER,
      key.oidcClientId,
    );
  });

  it("rejects when the token's org claim does not match this key's own externalOrgId", async () => {
    const key = await insertKeyWithMapping(TENANT_A, {
      externalIssuer: EXTERNAL_ISSUER,
      externalOrgId: "external-org-verify-a-2",
    });
    mintedKeyIdsA.push(key.id);

    mockVerifyJwtForIssuer.mockResolvedValueOnce({
      sub: "external-person-2",
      email: "person2@example.com",
      iat: Math.floor(Date.now() / 1000),
      org_id: "some-other-org",
    });

    const res = await makeVerifyApp({
      userId: `apikey:${key.id}`,
      tenantId: TENANT_A,
      roles: ["entity:ticket:read"],
      email: "",
      displayName: "API Key",
      orgId: "tenant-a-primary-org-unrelated",
    }).request("/whoami", {
      headers: { "X-Acting-Person-Token": "some-token" },
    });

    expect(res.status).toBe(401);
  });

  it("scopes an external mapping's row lookup to its own tenant under RLS — tenant B's auth context never resolves tenant A's key", async () => {
    const key = await insertKeyWithMapping(TENANT_A, {
      externalIssuer: EXTERNAL_ISSUER,
      externalOrgId: "external-org-verify-cross-tenant-1",
    });
    mintedKeyIdsA.push(key.id);

    const res = await makeVerifyApp({
      userId: `apikey:${key.id}`,
      tenantId: TENANT_B,
      roles: ["entity:ticket:read"],
      email: "",
      displayName: "API Key",
      orgId: "tenant-b-org",
    }).request("/whoami", {
      headers: { "X-Acting-Person-Token": "some-token" },
    });

    expect(res.status).toBe(401);
    expect(mockVerifyJwtForIssuer).not.toHaveBeenCalled();
  });

  it("keeps the default (non-external) verification path unaffected — a key with no mapping still compares against auth.orgId (R1)", async () => {
    const key = await insertKeyWithMapping(TENANT_B, {
      externalIssuer: null,
      externalOrgId: null,
    });
    mintedKeyIdsB.push(key.id);

    const res = await makeVerifyApp({
      userId: `apikey:${key.id}`,
      tenantId: TENANT_B,
      roles: ["entity:ticket:read"],
      email: "",
      displayName: "API Key",
      orgId: "tenant-b-org",
    }).request("/whoami", {
      headers: { "X-Acting-Person-Token": "some-token" },
    });

    // No verifyJwtWithAudience mock is installed in this suite, so the
    // default path's real jose verification runs against a bogus token and
    // fails closed — proving the branch taken is the default one (it never
    // reaches mockVerifyJwtForIssuer at all), not that it succeeds.
    expect(res.status).toBe(401);
    expect(mockVerifyJwtForIssuer).not.toHaveBeenCalled();
  });
});
