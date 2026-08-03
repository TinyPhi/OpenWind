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
