/**
 * Regression test for a real production bug (found during a live redeploy,
 * not caught by any mocked unit test): api_keys.oidc_client_id's uniqueness
 * check in apps/api/src/routes/api-keys/create.ts deliberately runs a bare
 * `db.select()` OUTSIDE withTenantContext (it must see across all tenants —
 * a Zitadel Client ID identifies one external application, not one tenant's
 * registration of it). That query still hits api_keys' tenant_read RLS
 * policy, which casts `current_setting('app.tenant_id', true)` to ::uuid.
 *
 * On a real Postgres backend connection, current_setting(name, true) returns
 * NULL the first time a custom GUC is read — but after ANY prior SET/SET
 * LOCAL on that same connection (even one that already committed/rolled
 * back), it returns '' (empty string), not NULL, since that's the GUC's
 * reset value once initialized. requireAuth() (packages/auth/src/
 * middleware.ts) always runs its own withTenantContext block first on every
 * authenticated request (to upsert tenant_users) — so by the time this
 * route's bare query runs, on postgres-js's reused connection, the RLS
 * policy's cast throws `invalid input syntax for type uuid: ""` instead of
 * safely evaluating to no-match. Fixed in migration 0090 by wrapping the
 * cast in nullif(..., '').
 *
 * Uses a real Postgres database (no mocks) — this class of bug is invisible
 * to a mocked-DB unit test by construction (see create.test.ts, which mocks
 * the DB entirely and never exercises real Postgres GUC semantics).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import { db, withTenantContext, apiKeys, tenants } from "@platform/db";

const TENANT = "cccccccc-0000-4000-c000-000000000090";

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "RLS Null-Safe GUC Test",
    slug: `rls-null-safe-guc-${TENANT}`,
  });
});

afterAll(async () => {
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

describe("api_keys tenant_read/tenant_write RLS survives a prior withTenantContext transaction on the same connection (migration 0090)", () => {
  it("a bare, unscoped query on api_keys after a withTenantContext call does not throw invalid uuid syntax", async () => {
    // Simulates requireAuth()'s own withTenantContext call, which runs on
    // every authenticated request before any route handler code — this is
    // what "poisons" the connection's app.tenant_id GUC into the ''-not-NULL
    // state that create.ts's bare query then runs into.
    await withTenantContext(TENANT, (tx) =>
      tx.select({ id: apiKeys.id }).from(apiKeys).limit(1),
    );

    // The exact query shape from create.ts's Client-ID uniqueness check —
    // deliberately outside withTenantContext, must not throw.
    await expect(
      db
        .select({ id: apiKeys.id, expiresAt: apiKeys.expiresAt })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.oidcClientId, "rls-guc-regression-test-client-id"),
            isNull(apiKeys.revokedAt),
            eq(apiKeys.oidcClientIdActive, true),
          ),
        ),
    ).resolves.toEqual([]);
  });
});
