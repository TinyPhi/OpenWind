/**
 * Isolation tests for 3B plugin system Phase 1 (migration 0059,
 * docs/specs/plugin-system.md R1/R2/R4/R4-addendum/R8).
 *
 * plugin_definitions is platform-wide (no tenant_id/RLS, same class as
 * connector_definitions) — readable by app_user regardless of tenant, writable
 * only by migration_user (no write grant in 0059). installed_plugins/plugin_errors
 * are tenant-scoped with a real FK to tenants(id) (same shape as
 * connector_delivery_attempts, not connector_credentials), so real tenant rows
 * are seeded here.
 *
 * The security-critical piece: create_plugin_schema() must let app_user create a
 * schema+role scoped to exactly one plugin slug, and that role must be unable to
 * write anywhere outside its own schema (R4's "enforced by grant, not convention").
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  pluginDefinitions,
  installedPlugins,
  pluginErrors,
} from "@platform/db";

const TENANT_A = "aaaaaaaa-0059-4000-a000-000000000059";
const TENANT_B = "bbbbbbbb-0059-4000-b000-000000000059";

let pluginId: string;
const testSlug = `isolation_test_plugin_${Date.now()}`.slice(0, 40);

beforeAll(async () => {
  await db
    .insert(tenants)
    .values([
      {
        id: TENANT_A,
        name: "3B isolation tenant A",
        slug: `plugin-system-tenant-a-${Date.now()}`,
      },
      {
        id: TENANT_B,
        name: "3B isolation tenant B",
        slug: `plugin-system-tenant-b-${Date.now()}`,
      },
    ])
    .onConflictDoNothing();

  const [row] = await db
    .insert(pluginDefinitions)
    .values({
      slug: testSlug,
      name: "Isolation Test Plugin",
      version: "0.1.0",
      category: "other",
    })
    .returning();
  if (!row) throw new Error("setup: failed to seed plugin_definitions row");
  pluginId = row.id;
});

afterAll(async () => {
  await db
    .delete(installedPlugins)
    .where(eq(installedPlugins.pluginId, pluginId));
  await db.delete(pluginErrors).where(eq(pluginErrors.pluginId, pluginId));
  await db.delete(pluginDefinitions).where(eq(pluginDefinitions.id, pluginId));
  // Clean up any schema/role the create_plugin_schema tests below created.
  await db.execute(
    sql`DROP SCHEMA IF EXISTS plugin_isolation_lint_target CASCADE`,
  );
  await db.execute(sql`DROP ROLE IF EXISTS plugin_role_isolation_lint_target`);
});

describe("plugin_definitions — catalog read access + write restriction", () => {
  it("app_user can read rows regardless of app.tenant_id (not tenant-scoped)", async () => {
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ slug: pluginDefinitions.slug })
        .from(pluginDefinitions)
        .where(eq(pluginDefinitions.id, pluginId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe(testSlug);
  });

  it("app_user INSERT fails with permission denied (no write grant)", async () => {
    // A deliberately short, valid slug — testSlug + a suffix can exceed the
    // 41-char format CHECK, which would fail for the wrong reason (23514)
    // before ever reaching the permission check this test is actually about.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.insert(pluginDefinitions).values({
          slug: `attempt_${Date.now()}`.slice(0, 40),
          name: "Should Not Insert",
          version: "0.1.0",
          category: "other",
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("rejects trust_tier values other than first_party", async () => {
    await expect(
      db.insert(pluginDefinitions).values({
        slug: `${testSlug}_thirdparty`,
        name: "Should Not Insert",
        version: "0.1.0",
        category: "other",
        trustTier: "third_party",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } }); // CHECK violation
  });

  it("rejects a slug that doesn't match the identifier-safe format", async () => {
    await expect(
      db.insert(pluginDefinitions).values({
        slug: "Not-A-Valid-Slug!",
        name: "Should Not Insert",
        version: "0.1.0",
        category: "other",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});

describe("installed_plugins — cross-tenant RLS isolation", () => {
  let rowAId: string;

  it("a tenant can insert and read its own install row", async () => {
    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .insert(installedPlugins)
        .values({
          tenantId: TENANT_A,
          pluginId,
          manifestSnapshot: { id: testSlug, name: "Test", version: "0.1.0" },
          version: "0.1.0",
        })
        .returning(),
    );
    expect(row).toBeDefined();
    rowAId = row!.id;
  });

  it("tenant B cannot see tenant A's install row", async () => {
    const rows = await withTenantContext(TENANT_B, (tx) =>
      tx.select().from(installedPlugins).where(eq(installedPlugins.id, rowAId)),
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects installing the same plugin twice for the same tenant", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(installedPlugins).values({
          tenantId: TENANT_A,
          pluginId,
          manifestSnapshot: { id: testSlug, name: "Test", version: "0.1.0" },
          version: "0.1.0",
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } }); // unique violation
  });

  it("tenant B cannot forge a row claiming to be tenant A's (RLS WITH CHECK)", async () => {
    await expect(
      withTenantContext(TENANT_B, (tx) =>
        tx.insert(installedPlugins).values({
          tenantId: TENANT_A,
          pluginId,
          manifestSnapshot: {},
          version: "0.1.0",
        }),
      ),
    ).rejects.toBeDefined();
  });
});

describe("plugin_errors — cross-tenant RLS isolation", () => {
  it("tenant A can write and read its own error row; tenant B cannot see it", async () => {
    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .insert(pluginErrors)
        .values({
          tenantId: TENANT_A,
          pluginId,
          kind: "lifecycle_failure",
          detail: { message: "test failure" },
        })
        .returning(),
    );
    expect(row).toBeDefined();

    const asB = await withTenantContext(TENANT_B, (tx) =>
      tx.select().from(pluginErrors).where(eq(pluginErrors.id, row!.id)),
    );
    expect(asB).toHaveLength(0);

    const asA = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(pluginErrors).where(eq(pluginErrors.id, row!.id)),
    );
    expect(asA).toHaveLength(1);
  });

  // Review finding (PR #397, PrabhuVijit, L2): installed_plugins already had a
  // WITH CHECK forgery test; plugin_errors only had USING coverage.
  it("tenant B cannot forge an error row claiming to be tenant A's (RLS WITH CHECK)", async () => {
    await expect(
      withTenantContext(TENANT_B, (tx) =>
        tx.insert(pluginErrors).values({
          tenantId: TENANT_A,
          pluginId,
          kind: "lifecycle_failure",
          detail: {},
        }),
      ),
    ).rejects.toBeDefined();
  });
});

describe("create_plugin_schema — R4 enforcement by grant, not convention", () => {
  const lintSlug = "isolation_lint_target";

  it("app_user can create a plugin schema+role via the function", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(sql`SELECT create_plugin_schema(${lintSlug})`);
    });

    const [role] = await db.execute<{ rolname: string }>(
      sql`SELECT rolname FROM pg_roles WHERE rolname = ${`plugin_role_${lintSlug}`}`,
    );
    expect(role).toBeDefined();

    const [schema] = await db.execute<{ schema_name: string }>(
      sql`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${`plugin_${lintSlug}`}`,
    );
    expect(schema).toBeDefined();
  });

  it("the plugin role can create a table inside its own schema", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(
        sql`SET LOCAL ROLE ${sql.raw(`plugin_role_${lintSlug}`)}`,
      );
      await tx.execute(
        sql`SET LOCAL search_path TO ${sql.raw(`plugin_${lintSlug}`)}`,
      );
      await tx.execute(
        sql`CREATE TABLE widgets (id uuid primary key default gen_random_uuid())`,
      );
    });

    const [table] = await db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables
          WHERE table_schema = ${`plugin_${lintSlug}`} AND table_name = 'widgets'`,
    );
    expect(table).toBeDefined();

    await db.execute(sql`DROP TABLE plugin_isolation_lint_target.widgets`);
  });

  it("the plugin role cannot write outside its own schema", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SET LOCAL ROLE ${sql.raw(`plugin_role_${lintSlug}`)}`,
        );
        await tx.execute(sql`CREATE TABLE public.should_not_exist (id int)`);
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("rejects an invalid slug before ever building dynamic SQL from it", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT create_plugin_schema(${"'; DROP TABLE tenants; --"})`,
        );
      }),
    ).rejects.toBeDefined();

    // The attempted injection must not have done anything — tenants still has
    // the two rows this file seeded (and whatever else was already there).
    const stillThere = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.id, TENANT_A)));
    expect(stillThere).toHaveLength(1);
  });
});
