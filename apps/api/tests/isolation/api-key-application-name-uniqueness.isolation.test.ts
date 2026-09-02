/**
 * Isolation tests for the api_keys.(tenant_id, lower(btrim(application_name)))
 * partial unique index (migration 0087) and create.ts's own pre-insert
 * conflict/reclaim check built on top of it.
 *
 * Uses a real Postgres database (no mocks). Proves, against the real
 * constraint and the real POST /api-keys route:
 * - two active keys in the SAME tenant cannot share a normalized
 *   applicationName, even with different casing/whitespace
 * - two different TENANTS can legitimately reuse the same applicationName
 *   (unlike oidcClientId's global index) — this index is tenant-scoped
 * - a revoked key's applicationName becomes reusable within its own tenant
 * - an EXPIRED-but-not-yet-revoked key's applicationName is reclaimed
 *   (auto-revoked) by create.ts's own pre-insert check, mirroring the
 *   existing oidcClientId reclaim behavior
 * - a genuinely different name never collides
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, withTenantContext, apiKeys, tenants } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { createApiKeyHandler } from "../../src/routes/api-keys/create.js";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000486";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000486";

const mintedKeyIdsA: string[] = [];
const mintedKeyIdsB: string[] = [];

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Application Name Uniqueness Test A",
      slug: `application-name-uniqueness-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Application Name Uniqueness Test B",
      slug: `application-name-uniqueness-b-${TENANT_B}`,
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

function skHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer sk_isolation_test_bypass",
  };
}

function mintBody(
  applicationName: string,
  clientId: string,
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    name: "application-name-uniqueness-test",
    scopes: ["entity:ticket:read"],
    applicationName,
    applicationContactEmail: "ops@application-name-uniqueness-test.example",
    oidcClientId: clientId,
    ...overrides,
  });
}

describe("POST /api-keys — applicationName uniqueness, real Postgres (migration 0087)", () => {
  it("mints a third-party key successfully with a fresh application name", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("App Name Fresh 1", "app-name-fresh-client-1"),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string } };
    mintedKeyIdsA.push(json.data.id);
  });

  it("rejects a second active key in the same tenant with a normalized-equal name (different case/whitespace, different Client ID)", async () => {
    const first = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("App Name Conflict 1", "app-name-conflict-client-1"),
    });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { data: { id: string } };
    mintedKeyIdsA.push(firstJson.data.id);

    const second = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody("  app name conflict 1  ", "app-name-conflict-client-2"),
    });
    expect(second.status).toBe(409);
    const secondJson = (await second.json()) as { error: string };
    expect(secondJson.error).toBe("APPLICATION_NAME_IN_USE");
  });

  it("allows two different tenants to register the same application name (index is tenant-scoped, unlike oidcClientId's global one)", async () => {
    const name = "App Name Cross Tenant 1";

    const inTenantA = await makeApp(TENANT_A).request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(name, "app-name-cross-tenant-client-a"),
    });
    expect(inTenantA.status).toBe(201);
    const jsonA = (await inTenantA.json()) as { data: { id: string } };
    mintedKeyIdsA.push(jsonA.data.id);

    const inTenantB = await makeApp(TENANT_B).request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(name, "app-name-cross-tenant-client-b"),
    });
    expect(inTenantB.status).toBe(201);
    const jsonB = (await inTenantB.json()) as { data: { id: string } };
    mintedKeyIdsB.push(jsonB.data.id);
  });

  it("allows reusing a revoked key's application name within the same tenant", async () => {
    const name = "App Name Reuse After Revoke 1";
    const first = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(name, "app-name-reuse-client-1"),
    });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { data: { id: string } };
    mintedKeyIdsA.push(firstJson.data.id);

    await withTenantContext(TENANT_A, (tx) =>
      tx
        .update(apiKeys)
        .set({ revokedAt: new Date(), revokedBy: "isolation-test-actor" })
        .where(eq(apiKeys.id, firstJson.data.id)),
    );

    const second = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(name, "app-name-reuse-client-2"),
    });
    expect(second.status).toBe(201);
    const secondJson = (await second.json()) as { data: { id: string } };
    mintedKeyIdsA.push(secondJson.data.id);
  });

  it("reclaims an expired-but-not-yet-revoked application name by auto-revoking it, then mints successfully", async () => {
    const name = "App Name Expiry Reclaim 1";
    const stale = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(name, "app-name-expiry-reclaim-client-1"),
    });
    expect(stale.status).toBe(201);
    const staleJson = (await stale.json()) as { data: { id: string } };
    mintedKeyIdsA.push(staleJson.data.id);

    await withTenantContext(TENANT_A, (tx) =>
      tx
        .update(apiKeys)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(apiKeys.id, staleJson.data.id)),
    );

    const reclaimed = await makeApp().request("/", {
      method: "POST",
      headers: skHeaders(),
      body: mintBody(name, "app-name-expiry-reclaim-client-2"),
    });
    expect(reclaimed.status).toBe(201);
    const reclaimedJson = (await reclaimed.json()) as { data: { id: string } };
    mintedKeyIdsA.push(reclaimedJson.data.id);

    const [staleRow] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ revokedAt: apiKeys.revokedAt, revokedBy: apiKeys.revokedBy })
        .from(apiKeys)
        .where(eq(apiKeys.id, staleJson.data.id)),
    );
    expect(staleRow?.revokedAt).not.toBeNull();
    expect(staleRow?.revokedBy).toBe("system:expiry-reclaim");
  });

  it("never collides on genuinely different application names", async () => {
    const [resA, resB] = await Promise.all([
      makeApp().request("/", {
        method: "POST",
        headers: skHeaders(),
        body: mintBody("App Name Distinct A", "app-name-distinct-a"),
      }),
      makeApp().request("/", {
        method: "POST",
        headers: skHeaders(),
        body: mintBody("App Name Distinct B", "app-name-distinct-b"),
      }),
    ]);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    const jsonA = (await resA.json()) as { data: { id: string } };
    const jsonB = (await resB.json()) as { data: { id: string } };
    mintedKeyIdsA.push(jsonA.data.id, jsonB.data.id);
  });
});
