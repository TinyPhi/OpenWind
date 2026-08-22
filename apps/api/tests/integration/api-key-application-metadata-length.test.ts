/**
 * DB-level tests for migrations 0070/0071's CHECK constraints bounding
 * api_keys.application_name/application_description/
 * application_contact_email (issue #445, found during PR #439 review) and
 * zitadel_client_id (issue #451, the same defect shape flagged in the same
 * review but kept out of #445's scope).
 *
 * Uses a real Postgres database (no mocks). These columns were added
 * unbounded by migration 0068 — the API layer's Zod schema (create.ts)
 * already bounds them, but that's not defense-in-depth on its own: any
 * write that bypasses the API (a script, a future code path, a bug) would
 * have hit an unbounded text column. Proves, against the real constraint:
 * - each column rejects a value over its bound
 * - each column accepts a value at/under its bound
 * - NULL (the shape of every pre-Phase-A key) is unaffected
 *
 * Not under tests/isolation/ — this proves a plain CHECK constraint, not
 * cross-tenant/RLS behavior (see api-key-client-id-uniqueness.isolation.test.ts
 * for that shape), so it belongs with this directory's other real-DB,
 * non-tenant-isolation coverage instead.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db, withTenantContext, apiKeys, tenants } from "@platform/db";
import { hashApiKey } from "@platform/auth";

const TENANT = "cccccccc-0000-4000-c000-000000000445";

const insertedKeyIds: string[] = [];

async function insertKey(overrides: Partial<typeof apiKeys.$inferInsert>) {
  const [row] = await withTenantContext(TENANT, (tx) =>
    tx
      .insert(apiKeys)
      .values({
        tenantId: TENANT,
        name: overrides.name ?? "application-metadata-length-test",
        keyHash: hashApiKey(
          `sk_app_metadata_length_test_${Math.random().toString(36).slice(2)}`,
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
  await db.insert(tenants).values({
    id: TENANT,
    name: "Application Metadata Length Test",
    slug: `application-metadata-length-${TENANT}`,
  });
});

afterAll(async () => {
  await db.delete(apiKeys).where(inArray(apiKeys.id, insertedKeyIds));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
});

const BOUNDED_COLUMNS = [
  {
    column: "applicationName" as const,
    limit: 200,
    valueAtLength: (n: number) => "a".repeat(n),
  },
  {
    column: "applicationDescription" as const,
    limit: 2000,
    valueAtLength: (n: number) => "a".repeat(n),
  },
  {
    column: "applicationContactEmail" as const,
    limit: 320,
    // "@a.com" is 6 chars — the local part must be (n - 6) chars to land
    // the whole value at exactly n.
    valueAtLength: (n: number) => `${"a".repeat(n - 6)}@a.com`,
  },
  {
    column: "zitadelClientId" as const,
    limit: 200,
    // Each generated value must be unique — zitadelClientId also carries a
    // partial unique index (migration 0068) among non-revoked keys, and
    // every insertKey() call here leaves its row active. randomUUID()
    // guarantees a fixed-length hex string, unlike Math.random()'s
    // variable-length base-36 output.
    valueAtLength: (n: number) =>
      `${"a".repeat(n - 6)}${randomUUID().replace(/-/g, "").slice(0, 6)}`,
  },
];

describe("api_keys column length constraints (migrations 0070/0071)", () => {
  it.each(BOUNDED_COLUMNS)(
    "rejects $column over its $limit-char limit",
    async ({ column, limit, valueAtLength }) => {
      await expect(
        insertKey({
          name: `${column}-over-limit`,
          [column]: valueAtLength(limit + 1),
        }),
      ).rejects.toThrow();
    },
  );

  it.each(BOUNDED_COLUMNS)(
    "accepts $column at exactly its $limit-char limit",
    async ({ column, limit, valueAtLength }) => {
      await expect(
        insertKey({
          name: `${column}-at-limit`,
          [column]: valueAtLength(limit),
        }),
      ).resolves.toBeDefined();
    },
  );

  it("allows NULL application metadata columns (every pre-Phase-A key's shape)", async () => {
    await expect(
      insertKey({ name: "no-application-metadata" }),
    ).resolves.toBeDefined();
  });
});
