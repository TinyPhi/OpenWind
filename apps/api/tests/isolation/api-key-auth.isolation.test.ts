/**
 * Isolation tests for API key authentication (#124-adjacent fix).
 *
 * api_keys has an RLS policy requiring app.tenant_id, but resolveApiKey must
 * look a key up by hash BEFORE it knows which tenant it belongs to -- that's
 * the whole point of the lookup. Migration 0031 adds a narrowly-scoped
 * SECURITY DEFINER function (resolve_api_key_by_hash) that bypasses RLS for
 * this one lookup-by-secret. These tests prove: a tenant's own key resolves
 * to that tenant (never another one), an unknown hash resolves to nothing,
 * and a full request through requireAuth() authenticates end-to-end against
 * real Postgres (no mocks).
 *
 * Uses a real Postgres database. Two isolated tenants (A and B) are seeded
 * before the suite and torn down after.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, withTenantContext, apiKeys, tenants } from "@platform/db";
import { requireAuth, hashApiKey, hashApiKeyArgon2 } from "@platform/auth";
import type { AuthContext } from "@platform/auth";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000033";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000034";

const RAW_KEY_A = "sk_isolation_test_tenant_a";
const RAW_KEY_B = "sk_isolation_test_tenant_b";
// Key C: inserted with argon2id hash (simulates a key created after migration 0047)
const RAW_KEY_C = "sk_isolation_test_argon2_key";

let keyAId: string;
let keyBId: string;
let keyCId: string;

beforeAll(async () => {
  // requireAuth's tenant-status check (resolveTenantStatus) reads the plain
  // `tenants` table directly, so both tenants need a real row to resolve as
  // "active" rather than "deleted" (tenants has no RLS -- see db-conventions).
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Isolation Test A",
      slug: `isolation-test-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Isolation Test B",
      slug: `isolation-test-b-${TENANT_B}`,
    },
  ]);

  const [rowA] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_A,
        name: "isolation-test-a",
        keyHash: hashApiKey(RAW_KEY_A),
        scopes: ["agent"],
      })
      .returning(),
  );
  const [rowB] = await withTenantContext(TENANT_B, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_B,
        name: "isolation-test-b",
        keyHash: hashApiKey(RAW_KEY_B),
        scopes: ["agent"],
      })
      .returning(),
  );
  // Key C: stored with both SHA-256 and argon2id hash (migration 0047 path)
  const keyHashArgon2C = await hashApiKeyArgon2(RAW_KEY_C);
  const [rowC] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_A,
        name: "isolation-test-argon2",
        keyHash: hashApiKey(RAW_KEY_C),
        keyHashArgon2: keyHashArgon2C,
        scopes: ["agent"],
      })
      .returning(),
  );
  if (!rowA || !rowB || !rowC) throw new Error("api key insert failed");
  keyAId = rowA.id;
  keyBId = rowB.id;
  keyCId = rowC.id;
});

afterAll(async () => {
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(apiKeys).where(eq(apiKeys.id, keyAId)),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.delete(apiKeys).where(eq(apiKeys.id, keyBId)),
  );
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(apiKeys).where(eq(apiKeys.id, keyCId)),
  );
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

describe("resolve_api_key_by_hash (migration 0031)", () => {
  it("resolves tenant A's key to tenant A, never tenant B", async () => {
    const rows = await db.execute<{
      id: string;
      tenant_id: string;
      scopes: string[];
    }>(
      sql`select * from resolve_api_key_by_hash(${hashApiKey(RAW_KEY_A)}::text)`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(keyAId);
    expect(rows[0]?.tenant_id).toBe(TENANT_A);
  });

  it("resolves tenant B's key to tenant B, never tenant A", async () => {
    const rows = await db.execute<{
      id: string;
      tenant_id: string;
      scopes: string[];
    }>(
      sql`select * from resolve_api_key_by_hash(${hashApiKey(RAW_KEY_B)}::text)`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(keyBId);
    expect(rows[0]?.tenant_id).toBe(TENANT_B);
  });

  it("returns nothing for an unknown key hash", async () => {
    const rows = await db.execute(
      sql`select * from resolve_api_key_by_hash(${hashApiKey("sk_totally_unknown")}::text)`,
    );
    expect(rows).toHaveLength(0);
  });

  it("never exposes key_hash in its result columns", async () => {
    const rows = await db.execute<Record<string, unknown>>(
      sql`select * from resolve_api_key_by_hash(${hashApiKey(RAW_KEY_A)}::text)`,
    );
    expect(Object.keys(rows[0] ?? {})).not.toContain("key_hash");
  });

  it("returns key_hash_argon2 when the key was stored with one (migration 0047)", async () => {
    const rows = await db.execute<{
      id: string;
      tenant_id: string;
      scopes: string[];
      key_hash_argon2: string | null;
    }>(
      sql`select * from resolve_api_key_by_hash(${hashApiKey(RAW_KEY_C)}::text)`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(keyCId);
    expect(rows[0]?.key_hash_argon2).toBeTruthy();
  });

  it("returns null key_hash_argon2 for legacy keys stored without one", async () => {
    const rows = await db.execute<{ key_hash_argon2: string | null }>(
      sql`select * from resolve_api_key_by_hash(${hashApiKey(RAW_KEY_A)}::text)`,
    );
    expect(rows[0]?.key_hash_argon2).toBeNull();
  });
});

describe("requireAuth end-to-end with an API key (real Postgres, no mocks)", () => {
  function makeApp() {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.get("/whoami", requireAuth(db), (c) => c.json({ auth: c.get("auth") }));
    return app;
  }

  it("authenticates tenant A's key and scopes auth context to tenant A", async () => {
    const res = await makeApp().request("/whoami", {
      headers: { Authorization: `Bearer ${RAW_KEY_A}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth: AuthContext };
    expect(body.auth.tenantId).toBe(TENANT_A);
  });

  it("rejects an unknown API key with 401", async () => {
    const res = await makeApp().request("/whoami", {
      headers: { Authorization: "Bearer sk_totally_unknown" },
    });
    expect(res.status).toBe(401);
  });

  it("records last_used_at on the correct tenant's row via the RLS-compliant write path", async () => {
    await makeApp().request("/whoami", {
      headers: { Authorization: `Bearer ${RAW_KEY_A}` },
    });
    // The middleware writes lastUsedAt fire-and-forget (#124 -- best-effort,
    // never blocks the request), so there's no synchronization point between
    // the response resolving and the write landing. Poll instead of reading
    // once immediately, which races the write under load.
    let row: { lastUsedAt: Date | null } | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      [row] = await withTenantContext(TENANT_A, (tx) =>
        tx
          .select({ lastUsedAt: apiKeys.lastUsedAt })
          .from(apiKeys)
          .where(eq(apiKeys.id, keyAId)),
      );
      if (row?.lastUsedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("authenticates a key stored with argon2id hash — end-to-end migration 0047 path (#238)", async () => {
    const res = await makeApp().request("/whoami", {
      headers: { Authorization: `Bearer ${RAW_KEY_C}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth: AuthContext };
    expect(body.auth.tenantId).toBe(TENANT_A);
  });

  // #195: requireAuth() now runs a post-auth, tenant-scoped rate-limit check
  // (packages/redis's checkRateLimit, keyed on the verified auth.tenantId)
  // before calling next(). It fails open on a Redis error, so this doesn't
  // assert on real bucketing here — this repo's dev/CI Redis container has no
  // host port mapping by design (docker-compose.yml), so a host-run isolation
  // suite can't reach it at all. The actual sliding-window bucketing logic is
  // unit-tested with a mocked Redis pipeline in packages/redis/src/
  // rate-limit.test.ts and packages/auth/src/middleware.test.ts. What IS
  // verified here, against real Postgres, is the thing an isolation suite
  // exists to catch: the new stage must never cross-contaminate tenants —
  // each tenant's request still authenticates to its own tenantId end-to-end.
  it("tenant A and tenant B each authenticate to their own tenantId through the added rate-limit stage", async () => {
    const [resA, resB] = await Promise.all([
      makeApp().request("/whoami", {
        headers: { Authorization: `Bearer ${RAW_KEY_A}` },
      }),
      makeApp().request("/whoami", {
        headers: { Authorization: `Bearer ${RAW_KEY_B}` },
      }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const bodyA = (await resA.json()) as { auth: AuthContext };
    const bodyB = (await resB.json()) as { auth: AuthContext };
    expect(bodyA.auth.tenantId).toBe(TENANT_A);
    expect(bodyB.auth.tenantId).toBe(TENANT_B);
  });
});
