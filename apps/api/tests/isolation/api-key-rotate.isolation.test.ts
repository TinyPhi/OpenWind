/**
 * Isolation tests for POST /api-keys/:id/rotate (ADR-008 Decision #3).
 *
 * Uses a real Postgres database (no mocks). Proves, against real RLS:
 * - a tenant can only rotate its own keys (cross-tenant rotate 404s)
 * - an already-revoked key cannot be rotated
 * - an already-expired key cannot be rotated (security-review finding: the
 *   route's own eligibility query must mirror resolve_api_key_by_hash's
 *   revoked/expired exclusion, not just check revokedAt)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, withTenantContext, apiKeys, tenants } from "@platform/db";
import { hashApiKey } from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import { rotateApiKeyHandler } from "../../src/routes/api-keys/rotate.js";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000053";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000053";

let activeKeyId: string;
let revokedKeyId: string;
let expiredKeyId: string;
const mintedKeyIds: string[] = [];

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT_A, name: "Rotate Test A", slug: `rotate-test-a-${TENANT_A}` },
    { id: TENANT_B, name: "Rotate Test B", slug: `rotate-test-b-${TENANT_B}` },
  ]);

  const [active] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_A,
        name: "active",
        keyHash: hashApiKey("sk_rotate_test_active"),
        scopes: ["agent"],
      })
      .returning({ id: apiKeys.id }),
  );
  const [revoked] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_A,
        name: "revoked",
        keyHash: hashApiKey("sk_rotate_test_revoked"),
        scopes: ["agent"],
        revokedAt: new Date(),
        revokedBy: "isolation-test-actor",
      })
      .returning({ id: apiKeys.id }),
  );
  const [expired] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_A,
        name: "expired",
        keyHash: hashApiKey("sk_rotate_test_expired"),
        scopes: ["agent"],
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: apiKeys.id }),
  );
  if (!active || !revoked || !expired) {
    throw new Error("api key insert failed");
  }
  activeKeyId = active.id;
  revokedKeyId = revoked.id;
  expiredKeyId = expired.id;
});

afterAll(async () => {
  // mintedKeyIds (rotated replacements) must be deleted before the original
  // keys they reference via rotated_from, or the FK constraint blocks it.
  for (const id of [...mintedKeyIds, activeKeyId, revokedKeyId, expiredKeyId]) {
    await withTenantContext(TENANT_A, (tx) =>
      tx.delete(apiKeys).where(eq(apiKeys.id, id)),
    );
  }
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

function makeApp(tenantId: string) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      tenantId,
      userId: "isolation-test-user",
      roles: ["admin"],
      email: "test@example.com",
    });
    await next();
  });
  app.post("/:id/rotate", ...rotateApiKeyHandler);
  return app;
}

// requireIntrospection() reads the Authorization header directly off the
// request regardless of the auth context already being set — an sk_-prefixed
// bearer token short-circuits it (API keys are exempt from introspection),
// avoiding the need for a live Zitadel connection in this test.
function skHeaders() {
  return { Authorization: "Bearer sk_isolation_test_bypass" };
}

describe("POST /api-keys/:id/rotate — real Postgres (ADR-008 Decision #3)", () => {
  it("rotates an active key and returns the replacement", async () => {
    const res = await makeApp(TENANT_A).request(`/${activeKeyId}/rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string; key: string } };
    expect(json.data.key).toMatch(/^sk_live_/);
    mintedKeyIds.push(json.data.id);
  });

  it("404s when rotating another tenant's key (no cross-tenant existence leak)", async () => {
    const res = await makeApp(TENANT_B).request(`/${activeKeyId}/rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("404s when rotating an already-revoked key", async () => {
    const res = await makeApp(TENANT_A).request(`/${revokedKeyId}/rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(res.status).toBe(404);
  });

  // Security-review finding: the eligibility query previously only checked
  // revokedAt, so an expired-but-not-revoked key could still be "rotated,"
  // resurrecting it with a fresh overlap window instead of staying dead.
  it("404s when rotating an already-expired key", async () => {
    const res = await makeApp(TENANT_A).request(`/${expiredKeyId}/rotate`, {
      method: "POST",
      headers: skHeaders(),
    });
    expect(res.status).toBe(404);
  });
});
