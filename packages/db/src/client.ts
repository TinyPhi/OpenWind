import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@platform/config";
import * as schema from "./schema/index.js";

const queryClient = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  idle_timeout: 30,
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
    await tx`SET LOCAL ROLE app_user`;
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx.unsafe(rawSql);
  });
}
