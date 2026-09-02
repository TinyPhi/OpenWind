/**
 * Isolation tests for POST /api-keys' third-party (action-scoped) mint path
 * (ADR-012 Phase A, PR A2 — branch feat/third-party-api-phase-a-mint-revoke) — specifically
 * the Client ID conflict/reclaim
 * logic, against a real Postgres. The unit tests in create.test.ts cover the
 * same logic against a mocked db; this proves the real SQL (the pre-insert
 * select + conditional update, both inside the same withTenantContext
 * transaction as the insert) actually behaves as intended, per this repo's
 * "prefer real implementation over mocks" testing convention.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, withTenantContext, apiKeys, tenants } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { createApiKeyHandler } from "../../src/routes/api-keys/create.js";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000439";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000439";

const mintedKeyIdsA: string[] = [];
const mintedKeyIdsB: string[] = [];

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Mint Client-ID Reclaim Test A",
      slug: `mint-client-id-reclaim-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Mint Client-ID Reclaim Test B",
      slug: `mint-client-id-reclaim-b-${TENANT_B}`,
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

const mintedKeyIds = mintedKeyIdsA;

function makeApp(tenantId: string = TENANT_A) {
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
// introspection — same pattern as the rotate isolation test.
function skHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer sk_isolation_test_bypass",
  };
}

function mintBody(clientId: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "third-party-mint-reclaim-test",
    scopes: ["entity:ticket:read"],
    // Migration 0087/0088 enforces per-tenant applicationName uniqueness
    // among active keys -- derived from the caller's own
    // (already-unique-per-call) clientId so this file's real subject
    // (Client ID reclaim) isn't accidentally blocked by an unrelated
    // applicationName collision between its own test cases.
    applicationName: `Reclaim Test App (${clientId})`,
    applicationContactEmail: "ops@reclaim-test.example",
    oidcClientId: clientId,
    ...overrides,
  });
}

describe("POST /api-keys — third-party mint Client ID reclaim, real Postgres (ADR-012 Phase A)", () => {
  it("mints a third-party key successfully with a fresh Client ID", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("reclaim-test-fresh-1"),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string } };
    mintedKeyIds.push(json.data.id);
  });

  it("rejects minting with a Client ID already held by another active key (409)", async () => {
    const first = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("reclaim-test-active-conflict-1"),
    });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { data: { id: string } };
    mintedKeyIds.push(firstJson.data.id);

    const second = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("reclaim-test-active-conflict-1"),
    });
    expect(second.status).toBe(409);
    const secondJson = (await second.json()) as { error: string };
    expect(secondJson.error).toBe("CLIENT_ID_IN_USE");
  });

  it("reclaims an expired-but-not-yet-revoked key's Client ID by auto-revoking it, then mints successfully", async () => {
    const staleId = "reclaim-test-expired-1";

    const stale = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(staleId),
    });
    expect(stale.status).toBe(201);
    const staleJson = (await stale.json()) as { data: { id: string } };
    mintedKeyIds.push(staleJson.data.id);

    // Simulate the key having expired without ever being revoked — exactly
    // the scenario the partial unique index alone can't exclude (its
    // predicate can only check revoked_at, not expires_at vs. now()).
    await withTenantContext(TENANT_A, (tx) =>
      tx
        .update(apiKeys)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(apiKeys.id, staleJson.data.id)),
    );

    const reclaimed = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(staleId),
    });
    expect(reclaimed.status).toBe(201);
    const reclaimedJson = (await reclaimed.json()) as { data: { id: string } };
    mintedKeyIds.push(reclaimedJson.data.id);
    expect(reclaimedJson.data.id).not.toBe(staleJson.data.id);

    const [staleRow] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ revokedAt: apiKeys.revokedAt, revokedBy: apiKeys.revokedBy })
        .from(apiKeys)
        .where(eq(apiKeys.id, staleJson.data.id)),
    );
    expect(staleRow?.revokedAt).not.toBeNull();
    expect(staleRow?.revokedBy).toBe("system:expiry-reclaim");
  });

  it("rejects a cross-tenant Client ID conflict with a clean 409 when the other tenant's key is still active", async () => {
    const clientId = "reclaim-test-cross-tenant-conflict-1";

    const inTenantA = await makeApp(TENANT_A).request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(clientId),
    });
    expect(inTenantA.status).toBe(201);
    const jsonA = (await inTenantA.json()) as { data: { id: string } };
    mintedKeyIdsA.push(jsonA.data.id);

    const inTenantB = await makeApp(TENANT_B).request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(clientId),
    });
    expect(inTenantB.status).toBe(409);
    const jsonB = (await inTenantB.json()) as { error: string };
    expect(jsonB.error).toBe("CLIENT_ID_IN_USE");
  });

  // Regression test for the review finding on PR #440 (PrabhuVijit): the
  // pre-insert conflict check used to run inside withTenantContext, so RLS's
  // tenant_read policy on api_keys hid every other tenant's rows from it —
  // including an *expired* one. Tenant B could then never reclaim a Client ID
  // that Tenant A had let expire, because the pre-check saw no conflict (so
  // no reclaim happened) while the DB's global unique index still rejected
  // the insert, permanently locking Tenant B out. Fixed by running the
  // conflict/reclaim check on the bare, RLS-bypassing `db` client instead —
  // this test fails with a 409 CLIENT_ID_IN_USE on the pre-fix code and must
  // pass with a 201 (Tenant A's expired key actually reclaimed) here.
  it("reclaims a cross-tenant EXPIRED Client ID instead of permanently blocking it", async () => {
    const clientId = "reclaim-test-cross-tenant-expired-1";

    const inTenantA = await makeApp(TENANT_A).request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(clientId),
    });
    expect(inTenantA.status).toBe(201);
    const jsonA = (await inTenantA.json()) as { data: { id: string } };
    mintedKeyIdsA.push(jsonA.data.id);

    // Simulate Tenant A's key having expired without ever being revoked.
    await withTenantContext(TENANT_A, (tx) =>
      tx
        .update(apiKeys)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(apiKeys.id, jsonA.data.id)),
    );

    const inTenantB = await makeApp(TENANT_B).request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(clientId),
    });
    expect(inTenantB.status).toBe(201);
    const jsonB = (await inTenantB.json()) as { data: { id: string } };
    mintedKeyIdsB.push(jsonB.data.id);

    const [staleRowA] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ revokedAt: apiKeys.revokedAt, revokedBy: apiKeys.revokedBy })
        .from(apiKeys)
        .where(eq(apiKeys.id, jsonA.data.id)),
    );
    expect(staleRowA?.revokedAt).not.toBeNull();
    expect(staleRowA?.revokedBy).toBe("system:expiry-reclaim");
  });
});
