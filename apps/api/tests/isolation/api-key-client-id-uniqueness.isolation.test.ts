/**
 * Isolation tests for the api_keys.oidc_client_id partial unique index
 * (migration 0072, ADR-012 Phase A, spec R7/§V).
 *
 * Uses a real Postgres database (no mocks). Proves, against the real
 * constraint:
 * - two active keys cannot share the same oidc_client_id, even across
 *   tenants (the index is not tenant-scoped — a Client ID identifies one
 *   external application, not one tenant's registration of it)
 * - a revoked key's oidc_client_id becomes reusable by a new key
 * - NULL oidc_client_id (keys not minted through the third-party flow)
 *   never collides with anything, including another NULL row
 * - an EXPIRED-but-not-yet-revoked key's oidc_client_id is, on its own at
 *   the DB layer, still rejected by the index (documented below, not a bug —
 *   see that test's own comment and the migration's). This is exactly why
 *   the mint endpoint (T2, PR A2) does its own expired-row reclaim check
 *   before inserting, rather than relying on this index alone.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, withTenantContext, apiKeys, tenants } from "@platform/db";
import { hashApiKey } from "@platform/auth";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000067";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000067";

const insertedKeyIds: string[] = [];

async function insertKey(
  tenantId: string,
  overrides: Partial<typeof apiKeys.$inferInsert>,
) {
  const [row] = await withTenantContext(tenantId, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId,
        name: overrides.name ?? "client-id-uniqueness-test",
        keyHash: hashApiKey(
          `sk_client_id_test_${Math.random().toString(36).slice(2)}`,
        ),
        scopes: ["agent"],
        ...overrides,
      })
      .returning({ id: apiKeys.id }),
  );
  if (!row) {
    throw new Error("api key insert failed");
  }
  insertedKeyIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Client ID Uniqueness Test A",
      slug: `client-id-uniqueness-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Client ID Uniqueness Test B",
      slug: `client-id-uniqueness-b-${TENANT_B}`,
    },
  ]);
});

afterAll(async () => {
  for (const id of insertedKeyIds) {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  }
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("api_keys.oidc_client_id uniqueness (migration 0072)", () => {
  it("rejects a second active key with the same oidc_client_id, even in a different tenant", async () => {
    await insertKey(TENANT_A, {
      name: "first-active",
      oidcClientId: "client-dup-test-1",
    });

    await expect(
      insertKey(TENANT_B, {
        name: "second-active-same-client-id",
        oidcClientId: "client-dup-test-1",
      }),
    ).rejects.toThrow();
  });

  it("allows a new key to reuse a revoked key's oidc_client_id", async () => {
    const revokedId = await insertKey(TENANT_A, {
      name: "will-be-revoked",
      oidcClientId: "client-reuse-test-1",
    });
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date(), revokedBy: "isolation-test-actor" })
      .where(eq(apiKeys.id, revokedId));

    const reusedId = await insertKey(TENANT_A, {
      name: "reuses-revoked-client-id",
      oidcClientId: "client-reuse-test-1",
    });

    expect(reusedId).not.toBe(revokedId);
  });

  it("STILL rejects reuse of an expired-but-not-yet-revoked key's oidc_client_id at the DB layer alone — this is the documented gap the mint endpoint (T2/PR A2) must close itself, not a bug in this index", async () => {
    // Postgres partial-index predicates must be immutable, so this index's
    // predicate can only be `revoked_at IS NULL` — it cannot also say
    // "and not expired" (that would need `expires_at > now()`, which is
    // stable, not immutable, and Postgres rejects it at CREATE INDEX time).
    // An expired row therefore still has revoked_at IS NULL and still holds
    // its Client ID as far as this index is concerned, even though the
    // platform's own invariant (§V) says an expired key's Client ID should
    // be reusable, same as a revoked one. Reviewed in PR #439 (PrabhuVijit):
    // flagging this as a genuine limitation of the DB constraint alone,
    // resolved one PR over by the mint endpoint's own pre-insert check
    // (reclaim-by-auto-revoking the stale expired row), not by this index.
    await insertKey(TENANT_A, {
      name: "expired-not-revoked",
      oidcClientId: "client-expired-reuse-test-1",
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      insertKey(TENANT_A, {
        name: "attempts-reuse-of-expired-clients-id",
        oidcClientId: "client-expired-reuse-test-1",
      }),
    ).rejects.toThrow();
  });
  it("never collides on NULL oidc_client_id across multiple keys", async () => {
    await expect(
      Promise.all([
        insertKey(TENANT_A, { name: "no-client-id-1" }),
        insertKey(TENANT_A, { name: "no-client-id-2" }),
        insertKey(TENANT_B, { name: "no-client-id-3" }),
      ]),
    ).resolves.toHaveLength(3);
  });
});
