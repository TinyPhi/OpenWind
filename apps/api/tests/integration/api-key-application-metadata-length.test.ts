/**
 * DB-level tests for migrations 0070/0071/0075's CHECK constraints bounding
 * api_keys.application_name/application_description/
 * application_contact_email (issue #445, found during PR #439 review) and
 * oidc_client_id (issue #451 / issue #474; column renamed from zitadel_client_id
 * by migration 0072, and forward-reconciled by migration 0075).
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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, sql } from "drizzle-orm";
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
    column: "oidcClientId" as const,
    limit: 200,
    // Each generated value must be unique — oidcClientId also carries a
    // partial unique index (migration 0068, renamed by 0072) among
    // non-revoked keys, and every insertKey() call here leaves its row
    // active. randomUUID() guarantees a fixed-length hex string, unlike
    // Math.random()'s variable-length base-36 output.
    valueAtLength: (n: number) =>
      `${"a".repeat(n - 6)}${randomUUID().replace(/-/g, "").slice(0, 6)}`,
  },
];

describe("api_keys column length constraints (migrations 0070/0071/0075)", () => {
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

/**
 * PR #479 review (issue #474): the BOUNDED_COLUMNS suite above only exercises
 * migration 0075's Branch 2 (neither constraint name exists -> ADD), which is
 * the fresh-DB path. Branch 1 (RENAME -- the path every pre-existing database
 * where 0071 ran before 0072 actually takes, i.e. the scenario that motivated
 * this fix) and Branch 3 (no-op -- new name already present) had zero coverage.
 * Re-executes 0075's own DO block SQL directly (not a copy of its logic) against
 * simulated pre-migration states, so this proves the shipped migration file
 * itself, not a re-implementation that could drift from it.
 */
describe("migration 0075 DO block branches (rename / no-op)", () => {
  const migration0075Sql = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../packages/db/migrations/0075_api_keys_oidc_client_id_length_limit.sql",
    ),
    "utf8",
  );

  async function constraintExists(name: string): Promise<boolean> {
    const [row] = await db.execute<{ exists: boolean }>(
      sql`SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = ${name} AND conrelid = 'public.api_keys'::regclass
      ) AS exists`,
    );
    return row?.exists ?? false;
  }

  // Same shape as BOUNDED_COLUMNS's oidcClientId.valueAtLength(201) above --
  // over the 200-char limit and unique, so it can't collide with the partial
  // uniqueness index and only the length CHECK is what rejects the insert.
  function overLimitOidcClientId(): string {
    return `${"a".repeat(195)}${randomUUID().replace(/-/g, "").slice(0, 6)}`;
  }

  it("Branch 3 (no-op): re-running 0075 when api_keys_oidc_client_id_length already exists leaves it untouched", async () => {
    expect(await constraintExists("api_keys_oidc_client_id_length")).toBe(true);

    await db.execute(sql.raw(migration0075Sql));

    expect(await constraintExists("api_keys_oidc_client_id_length")).toBe(true);
    expect(await constraintExists("api_keys_zitadel_client_id_length")).toBe(
      false,
    );
    await expect(
      insertKey({
        name: "0075-no-op-branch-enforcement",
        oidcClientId: overLimitOidcClientId(),
      }),
    ).rejects.toThrow();
  });

  it("Branch 1 (rename): simulated State A -- 0071's pre-rename constraint name is renamed forward by 0075, not dropped", async () => {
    // Simulate State A: an environment where 0071 ran before 0072, so the
    // length constraint still carries its original (pre-column-rename) name.
    await db.execute(
      sql`ALTER TABLE api_keys RENAME CONSTRAINT api_keys_oidc_client_id_length TO api_keys_zitadel_client_id_length`,
    );
    expect(await constraintExists("api_keys_zitadel_client_id_length")).toBe(
      true,
    );
    expect(await constraintExists("api_keys_oidc_client_id_length")).toBe(
      false,
    );

    await db.execute(sql.raw(migration0075Sql));

    expect(await constraintExists("api_keys_oidc_client_id_length")).toBe(true);
    expect(await constraintExists("api_keys_zitadel_client_id_length")).toBe(
      false,
    );
    await expect(
      insertKey({
        name: "0075-rename-branch-enforcement",
        oidcClientId: overLimitOidcClientId(),
      }),
    ).rejects.toThrow();
  });
});
