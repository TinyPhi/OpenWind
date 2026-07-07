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
