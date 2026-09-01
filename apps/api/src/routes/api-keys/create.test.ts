import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as PlatformAuth from "@platform/auth";
import type * as dbType from "@platform/db";

// ── Hoisted mutable auth fixture ──────────────────────────────────────────────

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["admin"] as string[],
    email: "test@example.com",
  },
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Defaults to allowing everything — the SSRF guard's own enforcement logic
// is unit-tested in packages/auth/src/ssrf-guard.test.ts; here it's only
// stubbed so create.ts's call site has something to call, with dedicated
// tests below overriding it to reject.
const mockAssertExternalIssuerEgressAllowed = vi.fn(() =>
  Promise.resolve(undefined),
);

vi.mock("@platform/auth", async () => {
  // detectScopesFormat is pure and has no side effects worth mocking — use the
  // real implementation so this test's insertArg.scopesFormat assertions stay
  // meaningful instead of hardcoding a duplicate copy of its logic here.
  const actual = await vi.importActual<typeof PlatformAuth>("@platform/auth");
  return {
    requireAuth:
      () =>
      async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
        c.set("auth", mockAuth as AuthContext);
        await next();
      },
    requireRole:
      (..._roles: string[]) =>
      async (_c: Context, next: Next) => {
        await next();
      },
    requireIntrospection: () => async (_c: Context, next: Next) => {
      await next();
    },
    hashApiKey: (key: string) => `sha256:${key}`,
    hashApiKeyArgon2: async (key: string) => `argon2id:${key}`,
    API_KEY_DEFAULT_TTL_DAYS: 365,
    detectScopesFormat: actual.detectScopesFormat,
    unknownTicketActionScopes: actual.unknownTicketActionScopes,
    assertExternalIssuerEgressAllowed: (...args: unknown[]) =>
      mockAssertExternalIssuerEgressAllowed(...args),
  };
});

const mockInsertValues = vi.fn();
const mockUpdateSet = vi.fn();
const mockWriteAuditEntry = vi.fn();

// Hoisted so tests can control what the pre-insert Client ID conflict lookup
// (the `db.select(...).from(apiKeys).where(...)` in create.ts — the bare,
// RLS-bypassing client, not the tenant-scoped `tx`) returns, without needing
// a real database.
const { mockSelectResult, mockInsertError, mockAppNameCandidates } = vi.hoisted(
  () => ({
    mockSelectResult: { rows: [] as unknown[] },
    // Lets a test simulate the database's own unique-violation on insert —
    // e.g. two concurrent requests racing for the same Client ID, both passing
    // the pre-insert check before either has inserted — so it can only ever be
    // caught here.
    mockInsertError: {
      error: null as { code: string; constraint_name: string } | null,
    },
    // Tenant-scoped applicationName conflict check's own select — defaults
    // to "no other active key in this tenant" (empty).
    mockAppNameCandidates: {
      rows: [] as Array<{
        id: string;
        applicationName: string | null;
        oidcClientId: string | null;
        expiresAt: Date | null;
      }>,
    },
  }),
);

vi.mock("@platform/db", async (importOriginal) => {
  const actual = await importOriginal<typeof dbType>();
  // The bare `db` client — used only for the pre-insert Client ID
  // conflict check/reclaim, which is deliberately global (bypasses RLS),
  // not tenant-scoped.
  const db = {
    select: () => db,
    from: () => db,
    where: () => Promise.resolve(mockSelectResult.rows),
    update: () => db,
    set: (...args: unknown[]) => {
      mockUpdateSet(...args);
      return db;
    },
  };
  return {
    ...actual,
    db,
    withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
      const tx = {
        insert: () => tx,
        values: (...args: unknown[]) => {
          mockInsertValues(...args);
          return tx;
        },
        returning: () => {
          if (mockInsertError.error) {
            // Matches Drizzle's real shape: a DrizzleQueryError whose `.cause`
            // is the actual PostgresError carrying code/constraint_name — not
            // those fields on the thrown error itself.
            const cause = new Error(
              "duplicate key value violates unique constraint",
            );
            Object.assign(cause, mockInsertError.error);
            const err = new Error("Failed query", { cause });
            return Promise.reject(err);
          }
          return Promise.resolve([
            {
              id: "key-1",
              name: "test-key",
              scopes: [],
              scopesFormat: "role",
              createdAt: new Date(),
              expiresAt: new Date("2027-08-09T00:00:00Z"),
            },
          ]);
        },
        // Tenant-scoped applicationName conflict check (create.ts, migration
        // 0086) — a separate select/update chain on the same tx object,
        // independent of the insert chain above.
        select: () => tx,
        from: () => tx,
        where: () => Promise.resolve(mockAppNameCandidates.rows),
        update: () => tx,
        set: (...args: unknown[]) => {
          mockUpdateSet(...args);
          return tx;
        },
      };
      return fn(tx);
    },
    apiKeys: {},
  };
});

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => {
    mockWriteAuditEntry(...args);
    return Promise.resolve();
  },
}));

const { createApiKeyHandler } = await import("./create.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/", ...createApiKeyHandler);
  return app;
}

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ name: "my-key", ...overrides });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api-keys — scope ceiling guard (#223)", () => {
  beforeEach(() => {
    mockAuth.roles = ["admin"];
  });

  it("returns 201 when scopes match creator role exactly", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["admin"] }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 201 when admin grants a lower-privilege scope (hierarchy check)", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["agent"] }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 403 when agent attempts to grant admin scope — escalation blocked", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["admin"] }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 403 for an unknown scope string", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["custom_role"] }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 201 for empty scopes array", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: [] }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 201 for default (no scopes field)", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });
    expect(res.status).toBe(201);
  });

  it("returns 403 when admin requests superadmin scope — privilege escalation blocked", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["superadmin"] }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 403 when admin requests a mix containing superadmin", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["admin", "superadmin"] }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 201 when superadmin requests superadmin scope", async () => {
    mockAuth.roles = ["superadmin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["superadmin"] }),
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /api-keys — argon2id hash storage (#237)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["admin"];
  });

  it("returns 201 and stores both SHA-256 and argon2id hashes", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });

    expect(res.status).toBe(201);
    expect(mockInsertValues).toHaveBeenCalledOnce();

    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.keyHash).toMatch(/^sha256:/);
    expect(insertArg.keyHashArgon2).toMatch(/^argon2id:/);
  });

  it("raw key is returned in the response body exactly once", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });

    const json = await res.json();
    expect(json.data.key).toMatch(/^sk_live_/);
    expect(json.data.keyHash).toBeUndefined();
    expect(json.data.keyHashArgon2).toBeUndefined();
  });
});

describe("POST /api-keys — lifecycle hardening (ADR-008 Decision #2/#3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["admin"];
  });

  it("stamps created_by with the caller's userId and sets a non-null expiresAt", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });

    expect(res.status).toBe(201);
    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.createdBy).toBe(mockAuth.userId);
    expect(insertArg.expiresAt).toBeInstanceOf(Date);
  });

  // Review finding (PR #373, L3): create.ts stamps scopesFormat on every
  // insert (ADR-008 Decision #6) — no prior assertion covered it.
  it("stamps scopesFormat on the insert and returns it in the response body", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["agent"] }),
    });

    expect(res.status).toBe(201);
    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.scopesFormat).toBe("role");

    const json = await res.json();
    expect(json.data.scopesFormat).toBe("role");
  });

  it("writes an audit entry for the new key (previously wrote none at all)", async () => {
    await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ name: "ci-key", scopes: ["agent"] }),
    });

    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const entry = mockWriteAuditEntry.mock.calls[0][1];
    expect(entry.action).toBe("created");
    expect(entry.resourceType).toBe("api_key");
    expect(entry.actorId).toBe(mockAuth.userId);
    expect(entry.resourceId).toBe("key-1");
  });

  it("returns expiresAt in the response body", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });

    const json = await res.json();
    expect(json.data.expiresAt).toBeDefined();
  });
});

function thirdPartyBody(overrides: Record<string, unknown> = {}) {
  return body({
    scopes: ["entity:ticket:read"],
    applicationName: "Acme Helpdesk Sync",
    applicationContactEmail: "ops@acme.example",
    oidcClientId: "acme-helpdesk-sync-client",
    ...overrides,
  });
}

describe("POST /api-keys — third-party (action-scoped) keys (ADR-012 Phase A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["admin"];
    mockSelectResult.rows = [];
    mockInsertError.error = null;
    mockAppNameCandidates.rows = [];
  });

  it("returns 201 for a well-formed third-party key request, bypassing the role ceiling entirely", async () => {
    mockAuth.roles = ["agent"]; // would 403 on the role-format path (#223) — must not apply here
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody(),
    });
    expect(res.status).toBe(201);

    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.scopesFormat).toBe("action");
    expect(insertArg.applicationName).toBe("Acme Helpdesk Sync");
    expect(insertArg.oidcClientId).toBe("acme-helpdesk-sync-client");
  });

  it("stamps a 3-month expiry, not the internal-key default TTL", async () => {
    const before = Date.now();
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody(),
    });
    expect(res.status).toBe(201);

    const insertArg = mockInsertValues.mock.calls[0][0];
    const expiresAt = (insertArg.expiresAt as Date).getTime();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThan(before + ninetyDaysMs - 5000);
    expect(expiresAt).toBeLessThan(before + ninetyDaysMs + 5000);
  });

  it("treats application fields + an empty scopes array as an ordinary role-format request (201, not 422) — an empty array can never classify as action-format", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ scopes: [] }),
    });
    expect(res.status).toBe(201);
    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.scopesFormat).toBe("role");
  });

  it("returns 422 for an unknown entity:ticket:<verb> scope string", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ scopes: ["entity:ticket:delete"] }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("INVALID_SCOPES");
  });

  it("returns 422 when applicationName is missing", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ applicationName: undefined }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 422 when applicationContactEmail is missing", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ applicationContactEmail: undefined }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when oidcClientId is missing", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ oidcClientId: undefined }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 400 for a malformed applicationContactEmail", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ applicationContactEmail: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an applicationContactEmail longer than the RFC 5321 320-char limit", async () => {
    // 317 'a's (local part) + "@a.com" (6 chars) = 323 total, over the
    // RFC 5321 320-char limit while still parsing as a well-formed email.
    const oversizedEmail = `${"a".repeat(317)}@a.com`;
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ applicationContactEmail: oversizedEmail }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the Client ID is already held by another active (non-expired) key", async () => {
    mockSelectResult.rows = [
      { id: "other-key", expiresAt: new Date(Date.now() + 60_000) },
    ];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody(),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("CLIENT_ID_IN_USE");
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("reclaims (auto-revokes) an expired-but-not-yet-revoked key holding the same Client ID, then succeeds", async () => {
    mockSelectResult.rows = [
      { id: "stale-expired-key", expiresAt: new Date(Date.now() - 60_000) },
    ];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody(),
    });
    expect(res.status).toBe(201);
    expect(mockUpdateSet).toHaveBeenCalledOnce();
    const updateArg = mockUpdateSet.mock.calls[0][0];
    expect(updateArg.revokedAt).toBeInstanceOf(Date);
    expect(updateArg.revokedBy).toBe("system:expiry-reclaim");
    expect(mockInsertValues).toHaveBeenCalledOnce();
  });

  it("proceeds with no conflict check needed when no existing row holds the Client ID", async () => {
    mockSelectResult.rows = [];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody(),
    });
    expect(res.status).toBe(201);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("returns 409 (not an unhandled 500) when the pre-insert check finds no conflict but the insert itself hits the unique index — e.g. two concurrent requests racing for the same Client ID", async () => {
    mockSelectResult.rows = []; // pre-check sees nothing — a concurrent insert wins the race first
    mockInsertError.error = {
      code: "23505",
      constraint_name: "api_keys_oidc_client_id_active_unique",
    };
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody(),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("CLIENT_ID_IN_USE");
  });

  it("does not misreport an unrelated unique-violation (a different constraint) as a Client ID conflict", async () => {
    mockSelectResult.rows = [];
    mockInsertError.error = {
      code: "23505",
      constraint_name: "api_keys_key_hash_key",
    };
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody(),
    });
    // Hono's default error handling resolves with a plain 500 for an
    // unhandled throw rather than rejecting the request() call — the point
    // of this test is just that it is NOT the specific 409 CLIENT_ID_IN_USE
    // response, i.e. the constraint-name check in create.ts's catch isn't
    // matching unrelated unique-violations.
    expect(res.status).not.toBe(409);
  });

  it("returns 422 (not an unhandled 500) when the insert hits any api_keys_<column>_length CHECK constraint — e.g. zitadelClientId's DB-layer bound (migration 0071)", async () => {
    mockSelectResult.rows = [];
    mockInsertError.error = {
      code: "23514",
      constraint_name: "api_keys_zitadel_client_id_length",
    };
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody(),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("does not misreport an unrelated CHECK-violation (a constraint not ending in _length) as a field-too-long error", async () => {
    mockSelectResult.rows = [];
    mockInsertError.error = {
      code: "23514",
      constraint_name: "api_keys_scopes_format_check",
    };
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody(),
    });
    expect(res.status).not.toBe(422);
  });
});

describe("POST /api-keys — external-org mapping (docs/specs/third-party-key-external-org-mapping.md)", () => {
  const EXTERNAL_ISSUER = "https://auth.external-idp-test.example";

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["admin"];
    mockSelectResult.rows = [];
    mockInsertError.error = null;
    mockAppNameCandidates.rows = [];
    mockAssertExternalIssuerEgressAllowed.mockReset();
    mockAssertExternalIssuerEgressAllowed.mockResolvedValue(undefined);
  });

  it("stores a valid externalIssuer/externalOrgId pair and runs it through the SSRF guard", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({
        externalIssuer: EXTERNAL_ISSUER,
        externalOrgId: "external-org-1",
      }),
    });
    expect(res.status).toBe(201);
    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.externalIssuer).toBe(EXTERNAL_ISSUER);
    expect(insertArg.externalOrgId).toBe("external-org-1");
    expect(mockAssertExternalIssuerEgressAllowed).toHaveBeenCalledWith(
      EXTERNAL_ISSUER,
    );
  });

  it("returns 422 when externalOrgId is supplied without externalIssuer", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ externalOrgId: "external-org-orphan" }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockAssertExternalIssuerEgressAllowed).not.toHaveBeenCalled();
  });

  it("returns 422 ORG_MAPPING_REQUIRED when externalIssuer is supplied without externalOrgId", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ externalIssuer: EXTERNAL_ISSUER }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("ORG_MAPPING_REQUIRED");
  });

  it("rejects externalIssuer/externalOrgId on a role-format key", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({
        externalIssuer: EXTERNAL_ISSUER,
        externalOrgId: "external-org-role-format",
      }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  // Security-review finding (docs/specs/third-party-key-external-org-mapping.md
  // Phase 2): create.ts must actually invoke the SSRF guard and fail closed
  // when it rejects, not just import it unused.
  it("returns 422 (not 201, not an unhandled 500) when the SSRF guard rejects the externalIssuer", async () => {
    mockAssertExternalIssuerEgressAllowed.mockRejectedValueOnce(
      new Error(
        'Issuer host "169.254.169.254" resolves to a private/reserved address',
      ),
    );
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({
        externalIssuer: "https://169.254.169.254",
        externalOrgId: "external-org-blocked",
      }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("rejects a malformed externalIssuer with a clean 400 (schema-level url() validation), never reaching the SSRF guard", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({
        externalIssuer: "not-a-url",
        externalOrgId: "external-org-malformed",
      }),
    });
    expect(res.status).toBe(400);
    expect(mockAssertExternalIssuerEgressAllowed).not.toHaveBeenCalled();
  });
});

describe("POST /api-keys — applicationName uniqueness (migration 0086, admin-ui card-view grouping)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["admin"];
    mockSelectResult.rows = [];
    mockInsertError.error = null;
    mockAppNameCandidates.rows = [];
  });

  it("returns 409 APPLICATION_NAME_IN_USE when another active key in this tenant already uses the same normalized name (different Client ID)", async () => {
    mockAppNameCandidates.rows = [
      {
        id: "other-key-1",
        applicationName: "  Acme Helpdesk Sync ",
        oidcClientId: "some-other-client-id",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ applicationName: "acme helpdesk sync" }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("APPLICATION_NAME_IN_USE");
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("does not conflict with itself when the matching row shares the same Client ID (e.g. a stale read of the same registration)", async () => {
    mockAppNameCandidates.rows = [
      {
        id: "other-key-1",
        applicationName: "Acme Helpdesk Sync",
        oidcClientId: "acme-helpdesk-sync-client",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ applicationName: "Acme Helpdesk Sync" }),
    });
    expect(res.status).toBe(201);
  });

  it("reclaims (auto-revokes) an expired-but-not-yet-revoked name conflict, then succeeds", async () => {
    mockAppNameCandidates.rows = [
      {
        id: "stale-expired-key",
        applicationName: "Acme Helpdesk Sync",
        oidcClientId: "some-other-client-id",
        expiresAt: new Date(Date.now() - 60_000),
      },
    ];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody({ applicationName: "Acme Helpdesk Sync" }),
    });
    expect(res.status).toBe(201);
    expect(mockUpdateSet).toHaveBeenCalledOnce();
    const updateArg = mockUpdateSet.mock.calls[0][0] as {
      revokedAt: Date;
      revokedBy: string;
    };
    expect(updateArg.revokedAt).toBeInstanceOf(Date);
    expect(updateArg.revokedBy).toBe("system:expiry-reclaim");
  });

  it("returns 409 (not an unhandled 500) when the pre-insert check finds no conflict but the insert itself hits the applicationName unique index — e.g. two concurrent requests racing for the same normalized name", async () => {
    mockAppNameCandidates.rows = [];
    mockInsertError.error = {
      code: "23505",
      constraint_name: "api_keys_tenant_application_name_active_unique",
    };
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody(),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("APPLICATION_NAME_IN_USE");
  });

  it("proceeds with no conflict when no other key shares the normalized name", async () => {
    mockAppNameCandidates.rows = [
      {
        id: "unrelated-key",
        applicationName: "Totally Different App",
        oidcClientId: "different-client-id",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: thirdPartyBody(),
    });
    expect(res.status).toBe(201);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});
