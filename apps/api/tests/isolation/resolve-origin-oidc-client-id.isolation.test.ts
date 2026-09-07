/**
 * Regression test for the origin-oidc-client-id RLS bug (found via manual
 * testing against a local AuthNexus/NexusOW setup through OWTesterUI): every
 * third-party ticket/comment/sub-ticket create 401'd with a generic "Invalid
 * API key" even for a genuinely valid key, because resolveOriginOidcClientId
 * queried api_keys on the bare `db` client instead of through
 * withTenantContext. api_keys has RLS (tenant_read/tenant_write, gated on
 * app.tenant_id) and the app connects as the non-superuser `app_user` role in
 * every real deployment — so the bare query silently saw zero rows and the
 * function returned null.
 *
 * The shared `db` test client in this suite connects as a Postgres
 * superuser (see apps/api/vitest.config.ts's DATABASE_URL default), which
 * bypasses RLS entirely — so a naive "call the exported function and check
 * it doesn't 401" test would pass on both the old buggy code and the fix,
 * proving nothing (this is exactly why the existing
 * third-party-ticket-create.isolation.test.ts suite never caught the bug).
 * This test instead reproduces the actual RLS mechanics directly: a
 * transaction that switches to app_user (same as withTenantContext does)
 * WITHOUT setting app.tenant_id — the precise state the old bare-`db` query
 * ran in — and confirms Postgres itself hides the row in that state, then
 * confirms the real exported function (which does set app.tenant_id via
 * withTenantContext) resolves it correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db, tenants, apiKeys, withTenantContext } from "@platform/db";
import { hashApiKey } from "@platform/auth";
import { resolveOriginOidcClientId } from "../../src/lib/resolve-origin-oidc-client-id.js";

const TENANT = "44444444-0000-4000-a000-000000000601";
const API_KEY_ID = "55555555-5555-5555-5555-555555555555";
const OIDC_CLIENT_ID = "resolve-origin-oidc-client-id-test-client";

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Resolve Origin OIDC Client ID Test Tenant",
    slug: `resolve-origin-oidc-${TENANT}`,
  });
  await db.insert(apiKeys).values({
    id: API_KEY_ID,
    tenantId: TENANT,
    name: "Resolve Origin OIDC Client ID Test Key",
    keyHash: hashApiKey(`sk_resolve_origin_test_${TENANT}`),
    scopesFormat: "action",
    scopes: ["entity:ticket:create"],
    oidcClientId: OIDC_CLIENT_ID,
  });
});

afterAll(async () => {
  await db.delete(apiKeys).where(eq(apiKeys.id, API_KEY_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

describe("resolveOriginOidcClientId", () => {
  it("an app_user query with no app.tenant_id set cannot see the key row (the exact bug scenario)", async () => {
    const [row] = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      // Deliberately no set_config('app.tenant_id', ...) here -- this is
      // what the old bare-`db` query effectively ran under in production.
      return tx.execute<{ oidc_client_id: string }>(
        sql`select oidc_client_id from api_keys where id = ${API_KEY_ID}::uuid`,
      );
    });
    expect(row).toBeUndefined();
  });

  it("resolves the key's oidcClientId when the tenant context is set (the fix)", async () => {
    const result = await resolveOriginOidcClientId(TENANT, API_KEY_ID);
    expect(result).toBe(OIDC_CLIENT_ID);
  });

  it("returns null for a tenant that doesn't own the key (RLS still enforces isolation)", async () => {
    const otherTenant = "44444444-0000-4000-a000-000000000602";
    const result = await resolveOriginOidcClientId(otherTenant, API_KEY_ID);
    expect(result).toBeNull();
  });

  it("withTenantContext-based resolution matches manual role+GUC setup", async () => {
    const [row] = await withTenantContext(TENANT, (tx) =>
      tx.execute<{ oidc_client_id: string }>(
        sql`select oidc_client_id from api_keys where id = ${API_KEY_ID}::uuid`,
      ),
    );
    expect(row?.oidc_client_id).toBe(OIDC_CLIENT_ID);
  });
});
