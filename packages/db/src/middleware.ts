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
 * Switches to outbox_sweeper (BYPASSRLS, see 0064_outbox_sweeper_role.sql)
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

/**
 * Switches to schedule_sweeper (BYPASSRLS, see
 * 0107_schedule_sweeper_role.sql) for the remainder of the current
 * transaction. For schedule-tick-worker.ts's schedulerTick/claimRule, which
 * poll and claim due `schedule_rules` *across all tenants* in one pass —
 * same situation setOutboxSweeperRole solves for outbox_events. Scoped to
 * just that transaction; every other query on the connection keeps full RLS
 * enforcement.
 */
export async function setScheduleSweeperRole(tx: Tx): Promise<void> {
  await tx.execute(sql`SET LOCAL ROLE schedule_sweeper`);
}

/**
 * Switches to oncall_rotation_sweeper (BYPASSRLS, column-scoped SELECT on on_call_rotations
 * only, see 0158_oncall_rotations.sql) for the remainder of the current transaction. For
 * oncall-rotation-worker's cross-tenant discovery of due rotations; the work on each rotation
 * then runs under withTenantContext, so RLS applies to every write.
 */
export async function setOncallRotationSweeperRole(tx: Tx): Promise<void> {
  await tx.execute(sql`SET LOCAL ROLE oncall_rotation_sweeper`);
}

/**
 * Runs `fn` as platform_admin_role (column-scoped GRANT on `tenants` only, see
 * 0135_platform_admin_sandbox_columns.sql and ADR-022 Decision 1) instead of app_user +
 * a tenant_id GUC. There is no tenant to scope to -- a platform_admin request is
 * cross-tenant by design (docs/specs/multi-org-sandbox.md R1/R2). Unlike
 * setOutboxSweeperRole/setScheduleSweeperRole, platform_admin_role is NOT BYPASSRLS: it
 * has no grant on any business-data table at all, so a query against one fails with a
 * permission error rather than silently returning rows regardless of RLS.
 *
 * Every route reachable by the platform_admin auth path (packages/auth's
 * requirePlatformAdmin) must read through this helper, never withTenantContext or the
 * plain `db` export -- using plain `db` would run as whatever role owns the pool
 * connection (often a superuser in local/dev), which bypasses this restriction entirely.
 */
export async function withPlatformAdminContext<T>(
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE platform_admin_role`);
    return fn(tx);
  });
}

/**
 * For the few writes that create a tenant, change its lifecycle status, or roll back a
 * just-created sandbox tenant. app_user deliberately cannot do these (#404-#408); this role
 * (migration 0143) can, but only INSERT/DELETE on `tenants` and UPDATE of status,
 * suspended_at, deletion_scheduled_at and updated_at -- name, plan, slug, config and the
 * sandbox columns stay out of reach. Use it for exactly those statements, nothing else.
 */
export async function withTenantLifecycleContext<T>(
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE tenant_lifecycle_role`);
    return fn(tx);
  });
}

/**
 * For tenant-purge's privileged pre-steps only: archive schedule_rules, delete
 * schedule_executions and saved_views, and anonymize admin_audit_log -- writes app_user
 * can't make (migration 0144). app.tenant_id is set too, so the tables' tenant RLS policies
 * still confine every statement to `tenantId`; callers keep their explicit tenant_id filters.
 */
export async function withTenantPurgeContext<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE tenant_purge_role`);
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    return fn(tx);
  });
}

/**
 * For the only paths that may delete workflow_events rows: the retention sweep, tenant purge
 * and sandbox reset (migration 0147). app_user cannot DELETE them. app.tenant_id is set so the
 * table's tenant RLS policy still confines every statement to `tenantId`; callers keep their
 * explicit tenant_id filters. The role can also read entity_instances and workflow_states, for
 * the sweep's open-case guard.
 */
export async function withEventLogMaintenanceContext<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE event_log_maintenance_role`);
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
