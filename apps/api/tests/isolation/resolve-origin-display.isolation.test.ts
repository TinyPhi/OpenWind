/**
 * Regression test for the origin-display RLS bug (found via manual testing
 * against a local AuthNexus/NexusOW setup: a ticket's "Created via <appName>
 * by <performer>" tag showed "Created via Unknown application" for a
 * genuinely-named key). Same root cause and same fix shape as
 * resolve-origin-oidc-client-id.isolation.test.ts: lookupApplicationName and
 * batchLookupApplicationNames (apps/api/src/lib/resolve-origin-display.ts)
 * queried api_keys on the bare `db` client instead of through
 * withTenantContext, so the RLS-gated SELECT silently returned zero rows in
 * every real (non-superuser) deployment and always fell back to the
 * "Unknown application" placeholder.
 *
 * As with the sibling test, the shared `db` test client here connects as a
 * Postgres superuser (apps/api/vitest.config.ts's DATABASE_URL default),
 * which bypasses RLS entirely — so this test reproduces the actual RLS
 * mechanics directly (SET LOCAL ROLE app_user with no app.tenant_id set)
 * rather than relying on the ambient connection's privilege level.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, tenants, apiKeys, withTenantContext } from "@platform/db";
import { hashApiKey } from "@platform/auth";
import { batchLookupApplicationNames } from "../../src/lib/resolve-origin-display.js";

const TENANT_A = "66666666-0000-4000-a000-000000000701";
const TENANT_B = "66666666-0000-4000-a000-000000000702";
const API_KEY_ID = "77777777-7777-7777-7777-777777777777";
const OIDC_CLIENT_ID = "resolve-origin-display-test-client";
const APPLICATION_NAME = "Resolve Origin Display Test App";

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Resolve Origin Display Test Tenant A",
      slug: `resolve-origin-display-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Resolve Origin Display Test Tenant B",
      slug: `resolve-origin-display-b-${TENANT_B}`,
    },
  ]);
  await db.insert(apiKeys).values({
    id: API_KEY_ID,
    tenantId: TENANT_A,
    name: "Resolve Origin Display Test Key",
    keyHash: hashApiKey(`sk_resolve_origin_display_test_${TENANT_A}`),
    scopesFormat: "action",
    scopes: ["entity:ticket:create"],
    oidcClientId: OIDC_CLIENT_ID,
    applicationName: APPLICATION_NAME,
  });
});

afterAll(async () => {
  await db.delete(apiKeys).where(eq(apiKeys.id, API_KEY_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

describe("resolveOriginDisplay's application-name lookup", () => {
  it("an app_user query with no app.tenant_id set cannot see the key row (the exact bug scenario)", async () => {
    const [row] = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      return tx.execute<{ application_name: string }>(
        sql`select application_name from api_keys where oidc_client_id = ${OIDC_CLIENT_ID}`,
      );
    });
    expect(row).toBeUndefined();
  });

  it("batchLookupApplicationNames resolves the key's name when scoped to its own tenant (the fix)", async () => {
    const nameByClientId = await batchLookupApplicationNames(TENANT_A, [
      {
        originMechanism: "api",
        originOidcClientId: OIDC_CLIENT_ID,
        originPerformerUserId: null,
      },
    ]);
    expect(nameByClientId.get(OIDC_CLIENT_ID)).toBe(APPLICATION_NAME);
  });

  it("returns nothing for a tenant that doesn't own the key (RLS still enforces isolation)", async () => {
    const nameByClientId = await batchLookupApplicationNames(TENANT_B, [
      {
        originMechanism: "api",
        originOidcClientId: OIDC_CLIENT_ID,
        originPerformerUserId: null,
      },
    ]);
    expect(nameByClientId.has(OIDC_CLIENT_ID)).toBe(false);
  });

  it("withTenantContext-based resolution matches manual role+GUC setup", async () => {
    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx.execute<{ application_name: string }>(
        sql`select application_name from api_keys where oidc_client_id = ${OIDC_CLIENT_ID}`,
      ),
    );
    expect(row?.application_name).toBe(APPLICATION_NAME);
  });
});
