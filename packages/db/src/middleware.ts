import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type {
  PostgresJsQueryResultHKT,
  PostgresJsDatabase,
} from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type * as schema from "./schema/index.js";
import { db } from "./client.js";

type Tx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type DbOrTx = PostgresJsDatabase<typeof schema> | Tx;

export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Switch to app_user so RLS policies are enforced (superusers bypass RLS by default).
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    return fn(tx);
  });
}

/**
 * Switches to outbox_sweeper (BYPASSRLS, see 0053_outbox_sweeper_role.sql)
 * for the remainder of the current transaction. For the handful of workers
 * that sweep outbox_events *across all tenants* in one query (there is no
 * single tenant to scope app.tenant_id to) — outbox-poller.ts,
 * notification-poller.ts, sla-scheduler.ts, alert-scheduler.ts,
 * due-date-scheduler.ts. Scoped to just that transaction; every other query
 * on the connection keeps full RLS enforcement.
 *
 * sla-scheduler.ts additionally calls this a second time after its
 * per-tenant dead-letter loop, which switches down to app_user+tenant_id —
 * without restoring outbox_sweeper first, the final cross-tenant
 * delivered_at UPDATE would silently only affect the last tenant touched by
 * that loop under RLS.
 */
export async function setOutboxSweeperRole(tx: Tx): Promise<void> {
  await tx.execute(sql`SET LOCAL ROLE outbox_sweeper`);
}

export async function withTenantAndUserContext<T>(
  tenantId: string,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Switch to app_user so RLS policies are enforced (superusers bypass RLS by default).
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true)`,
    );
    return fn(tx);
  });
}
