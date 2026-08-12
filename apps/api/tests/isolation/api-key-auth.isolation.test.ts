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
// Key D: revoked (ADR-008 Decision #4). Key E: expired (ADR-008 Decision #3).
const RAW_KEY_D = "sk_isolation_test_revoked_key";
const RAW_KEY_E = "sk_isolation_test_expired_key";
// Key F: explicit action-format scopes (ADR-008 Decision #6, migration 0054).
const RAW_KEY_F = "sk_isolation_test_action_scopes_key";

let keyAId: string;
let keyBId: string;
let keyCId: string;
let keyDId: string;
let keyEId: string;
let keyFId: string;

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
  // Key D: revoked at insert time (simulates a key soft-revoked via DELETE /api-keys/:id)
  const [rowD] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_A,
        name: "isolation-test-revoked",
        keyHash: hashApiKey(RAW_KEY_D),
        scopes: ["agent"],
        revokedAt: new Date(),
        revokedBy: "isolation-test-actor",
      })
      .returning(),
  );
  // Key E: expiresAt in the past (simulates a key past its ADR-008 Decision #3 lifetime)
  const [rowE] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_A,
        name: "isolation-test-expired",
        keyHash: hashApiKey(RAW_KEY_E),
        scopes: ["agent"],
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning(),
  );
  // Key F: minted directly with action-format scopes and scopes_format='action'
  // — proves the new column round-trips per-tenant under RLS. (Real issuance
  // still goes through create.ts's ceiling check, which today rejects any
  // non-role-string scope; this bypasses that on purpose to test the column
  // itself, independent of when the ceiling is reopened.)
  const [rowF] = await withTenantContext(TENANT_B, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT_B,
        name: "isolation-test-action-scopes",
        keyHash: hashApiKey(RAW_KEY_F),
        scopes: ["entity:ticket:read"],
        scopesFormat: "action",
      })
      .returning(),
  );
  if (!rowA || !rowB || !rowC || !rowD || !rowE || !rowF) {
    throw new Error("api key insert failed");
  }
  keyAId = rowA.id;
  keyBId = rowB.id;
  keyCId = rowC.id;
  keyDId = rowD.id;
  keyEId = rowE.id;
  keyFId = rowF.id;
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
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(apiKeys).where(eq(apiKeys.id, keyDId)),
  );
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(apiKeys).where(eq(apiKeys.id, keyEId)),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.delete(apiKeys).where(eq(apiKeys.id, keyFId)),
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

  // ADR-008 Decision #4: soft-revoke changes deletion from a hard delete to
  // setting revoked_at — this proves the row surviving as data doesn't also
  // mean it keeps authenticating.
  it("returns nothing for a revoked key (migration 0053)", async () => {
    const rows = await db.execute(
      sql`select * from resolve_api_key_by_hash(${hashApiKey(RAW_KEY_D)}::text)`,
    );
    expect(rows).toHaveLength(0);
  });

  // ADR-008 Decision #3: a key past its expires_at must stop authenticating
  // without needing revoked_at set — expiry and revocation are independent.
  it("returns nothing for an expired key (migration 0053)", async () => {
    const rows = await db.execute(
      sql`select * from resolve_api_key_by_hash(${hashApiKey(RAW_KEY_E)}::text)`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("api_keys.scopes_format (migration 0055, ADR-008 Decision #6)", () => {
  it("defaults to 'role' for a key created without an explicit scopes_format", async () => {
    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ scopesFormat: apiKeys.scopesFormat })
        .from(apiKeys)
        .where(eq(apiKeys.id, keyAId)),
    );
    expect(row?.scopesFormat).toBe("role");
  });

  it("persists an explicit 'action' scopes_format scoped to its own tenant, under RLS", async () => {
    const [rowInTenantB] = await withTenantContext(TENANT_B, (tx) =>
      tx
        .select({ scopesFormat: apiKeys.scopesFormat, scopes: apiKeys.scopes })
        .from(apiKeys)
        .where(eq(apiKeys.id, keyFId)),
    );
    expect(rowInTenantB?.scopesFormat).toBe("action");
    expect(rowInTenantB?.scopes).toEqual(["entity:ticket:read"]);

    // RLS: tenant A's session must not see tenant B's action-scoped key at all.
    const rowsInTenantA = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(apiKeys).where(eq(apiKeys.id, keyFId)),
    );
    expect(rowsInTenantA).toHaveLength(0);
  });

  it("rejects a scopes_format value outside ('role', 'action')", async () => {
    // scopesFormat's Drizzle type is now the "role" | "action" union (review
    // finding L1, PR #373) — the cast below is the explicit bypass that
    // typing intentionally requires to construct this otherwise-unreachable
    // value, so the CHECK constraint (not TypeScript) is what's under test.
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(apiKeys).values({
          tenantId: TENANT_A,
          name: "isolation-test-bad-format",
          keyHash: hashApiKey("sk_isolation_test_bad_format"),
          scopes: [],
          scopesFormat: "bogus" as "role" | "action",
        }),
      ),
      // Pinned to the CHECK constraint specifically (Postgres code 23514,
      // nested under Drizzle's wrapping DrizzleQueryError.cause), not any
      // thrown error — a connection failure would otherwise also satisfy a
      // bare .rejects.toThrow() (review finding L5, PR #373).
    ).rejects.toMatchObject({ cause: { code: "23514" } });
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

  it("rejects a revoked API key with 401 — same as an unknown key, no distinct signal (ADR-008 Decision #4)", async () => {
    const res = await makeApp().request("/whoami", {
      headers: { Authorization: `Bearer ${RAW_KEY_D}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects an expired API key with 401 (ADR-008 Decision #3)", async () => {
    const res = await makeApp().request("/whoami", {
      headers: { Authorization: `Bearer ${RAW_KEY_E}` },
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
