import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@platform/config";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema/index.js";

const queryClient = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  idle_timeout: 30,
  prepare: false, // pgbouncer transaction mode does not support server-side prepared statements
});

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;

/**
 * Execute a raw SQL string inside a tenant-scoped transaction using the simple
 * query protocol (postgres-js `unsafe()`). Required for data-modifying CTEs
 * and multi-statement SQL that Drizzle's extended protocol cannot handle.
 */
export async function executeRawInTenantContext(
  tenantId: string,
  rawSql: string,
): Promise<void> {
  await queryClient.begin(async (tx) => {
    // Switch to app_user so RLS policies are enforced (superusers bypass RLS by default).
    // If module seed SQL hits "permission denied for table X", app_user is missing a
    // grant on X — add it following the pattern in 0022_app_user_rls_grants.sql.
    await tx`SET LOCAL ROLE app_user`;
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx.unsafe(rawSql);
  });
}

const PLUGIN_SLUG_RE = /^[a-z][a-z0-9_]{2,40}$/;

export class InvalidPluginSlugError extends Error {
  constructor(public readonly slug: string) {
    super(`Invalid plugin slug: ${slug}`);
    this.name = "InvalidPluginSlugError";
  }
}

/**
 * Runs a single plugin's migration SQL inside its own dedicated schema (3B,
 * docs/specs/plugin-system.md R3/R4). Same shape as executeRawInTenantContext
 * above (raw multi-statement execution via postgres-js's simple query protocol)
 * with a different role sequence: app_user (to call create_plugin_schema) -> the
 * plugin's own schema-scoped role (to run its migration).
 *
 * Does NOT share a transaction with the caller's own drizzle-based writes —
 * same precedent executeRawInTenantContext already established (raw
 * queryClient.begin() and a drizzle db.transaction() are different transaction
 * contexts; module-service.ts's installModule already uses this "compensating
 * design" rather than forcing atomicity). create_plugin_schema's own idempotency
 * (CREATE SCHEMA IF NOT EXISTS, a guarded CREATE ROLE) makes a retried install
 * safe if a failure happens between this succeeding and the caller's
 * installed_plugins write landing.
 *
 * The plugin slug is re-validated here even though plugin_definitions.slug is
 * already DB-CHECK-constrained to the same pattern — this function must be safe
 * to call on its own terms, independent of that constraint ever being bypassed,
 * before the slug is used to build the SET LOCAL ROLE statement (a role name
 * cannot be a bind parameter in Postgres, so this validation is what makes plain
 * string interpolation safe here — not an oversight).
 */
export async function runPluginMigration(
  pluginSlug: string,
  migrationSql: string,
): Promise<void> {
  if (!PLUGIN_SLUG_RE.test(pluginSlug)) {
    throw new InvalidPluginSlugError(pluginSlug);
  }
  const schemaName = `plugin_${pluginSlug}`;
  const roleName = `plugin_role_${pluginSlug}`;

  await queryClient.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    await tx`SELECT create_plugin_schema(${pluginSlug})`;

    // Safe: roleName/schemaName are built only from a value that just passed
    // PLUGIN_SLUG_RE above (lowercase letters, digits, underscore only — no
    // quote characters, no way to break out of the surrounding SQL text).
    await tx.unsafe(`SET LOCAL ROLE ${roleName}`);
    await tx.unsafe(`SET LOCAL search_path TO ${schemaName}`);

    if (migrationSql.trim().length > 0) {
      await tx.unsafe(migrationSql);
    }
  });
}

// Postgres identifiers are case-sensitive when quoted and can technically contain
// almost anything — this pattern is deliberately narrower than what Postgres
// itself allows, matching this file's own table-naming convention (snake_case),
// so a table_name value from information_schema is safe to interpolate into a
// double-quoted identifier below without ever needing to itself contain a quote.
const SAFE_TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Deletes one tenant's rows from every table in one plugin's schema that has a
 * `tenant_id` column (docs/specs/plugin-system.md R13). Used by both plugin
 * uninstall (R9 — a single tenant's rows only, schema untouched, since other
 * tenants may still have the plugin installed) and tenant deletion (this file's
 * own tenant-purge path, apps/worker/src/tenant-purge.ts) — R13 requires both,
 * not just the uninstall path, since deleting a tenant is a different event
 * from that tenant uninstalling one plugin.
 *
 * Table names come from information_schema (Postgres's own catalog of what
 * actually exists in this schema), not from any external input, but are still
 * validated against SAFE_TABLE_NAME_RE before being interpolated into a
 * double-quoted identifier — belt-and-suspenders, same posture as the slug
 * validation above. tenantId is passed as a bind parameter, never interpolated.
 */
export async function purgeTenantDataFromPluginSchema(
  tenantId: string,
  pluginSlug: string,
): Promise<{ tablesPurged: string[] }> {
  if (!PLUGIN_SLUG_RE.test(pluginSlug)) {
    throw new InvalidPluginSlugError(pluginSlug);
  }
  const schemaName = `plugin_${pluginSlug}`;
  const roleName = `plugin_role_${pluginSlug}`;

  return queryClient.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    // If the plugin schema/role was never created (no plugin has ever been
    // installed by anyone), there is nothing to purge — not an error.
    const [role] = await tx`SELECT 1 FROM pg_roles WHERE rolname = ${roleName}`;
    if (!role) return { tablesPurged: [] };

    await tx.unsafe(`SET LOCAL ROLE ${roleName}`);

    const columns = await tx<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = ${schemaName} AND column_name = 'tenant_id'
    `;

    const tablesPurged: string[] = [];
    for (const { table_name: tableName } of columns) {
      if (!SAFE_TABLE_NAME_RE.test(tableName)) {
        throw new Error(
          `purgeTenantDataFromPluginSchema: unexpected table name shape "${tableName}" in schema ${schemaName}`,
        );
      }
      await tx.unsafe(
        `DELETE FROM "${schemaName}"."${tableName}" WHERE tenant_id = $1`,
        [tenantId],
      );
      tablesPurged.push(tableName);
    }
    return { tablesPurged };
  });
}

// Distinct from the seed automation-engine's transition-dedup lock uses
// (executor.ts's pg_advisory_xact_lock(hashtextextended(key, 0))) so the two
// lock classes can never collide even if their key strings ever coincided.
const TENANT_ADVISORY_LOCK_SEED = 1;

export interface TenantAdvisoryLock {
  acquired: boolean;
  release(): Promise<void>;
}

/**
 * Session-scoped advisory lock keyed by (namespace, tenantId), held on a
 * single reserved connection across multiple statements AND transactions --
 * unlike pg_advisory_xact_lock (see automation-engine/src/executor.ts), this
 * survives an external network call made between DB operations, because it
 * isn't tied to any one transaction's lifetime. It IS tied to the reserved
 * connection's lifetime: if the holding process crashes, Postgres releases
 * the lock the moment that connection drops -- no stale-lock timeout guess
 * needed, unlike a row-flag-based lock (docs/specs/org-directory.md T4's
 * runOrgDirectorySync — a security review of that PR found the row-based
 * stale-reclaim approach could steal a still-healthy sync's lock out from
 * under it; this replaced it).
 *
 * Non-blocking (pg_try_advisory_lock): if another session already holds the
 * lock for this key, `acquired` is false and the reserved connection is
 * released immediately -- callers should treat that as "already in progress"
 * and not retry in a loop.
 */
export async function acquireTenantAdvisoryLock(
  tenantId: string,
  namespace: string,
): Promise<TenantAdvisoryLock> {
  const reserved = await queryClient.reserve();
  const key = `${namespace}:${tenantId}`;
  let row: { locked: boolean } | undefined;
  try {
    [row] = await reserved<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${key}, ${TENANT_ADVISORY_LOCK_SEED})) AS locked
    `;
  } catch (err) {
    // Never leak the reserved connection -- a blip between reserve() and this
    // query must still hand the connection back to the pool.
    reserved.release();
    throw err;
  }
  if (!row?.locked) {
    reserved.release();
    return { acquired: false, release: async () => {} };
  }
  return {
    acquired: true,
    release: async () => {
      try {
        await reserved`SELECT pg_advisory_unlock(hashtextextended(${key}, ${TENANT_ADVISORY_LOCK_SEED}))`;
      } finally {
        reserved.release();
      }
    },
  };
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check if a tenant exists and its status is 'active'.
 * Runs outside withTenantContext because the tenants table is not tenant-scoped.
 */
export async function isTenantActive(tenantId: string): Promise<boolean> {
  if (!tenantId || !UUID_REGEX.test(tenantId)) return false;

  const [tenant] = await db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(
      and(eq(schema.tenants.id, tenantId), eq(schema.tenants.status, "active")),
    )
    .limit(1);
  return !!tenant;
}
