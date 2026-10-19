import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./client.js";
import { withPlatformAdminContext } from "./middleware.js";
import { platformAdminAuditLog } from "./schema/platform.js";
import type { DbOrTx } from "./middleware.js";

/**
 * T16 (docs/specs/multi-org-sandbox.md), ADR-022 Decision 7. Only completed actions are
 * recorded (spec R9) -- callers write this once, on the success path only, same convention
 * as the existing admin_audit_log writes (writeAuditEntry) these three actions already make
 * alongside this one.
 */
export type PlatformAdminAction =
  | "sandbox.created"
  | "sandbox.reset"
  | "sandbox.deleted"
  | "sandbox.trial_changed"
  | "sandbox.trial_ended";

export interface RecordPlatformAdminActionInput {
  actorSub: string;
  action: PlatformAdminAction;
  targetTenantId: string;
}

/**
 * Writes on the privileged `db` connection (not withPlatformAdminContext's SET LOCAL ROLE
 * platform_admin_role) -- platform_admin_role is granted SELECT only (migration 0141); the
 * three sandbox lifecycle workers that call this already run with full `db` access.
 *
 * @param tx - Optional transaction handle (#893). Guarded against platform_admin_role:
 * platform_admin_role is granted SELECT only on platform_admin_audit_log and will fail if a
 * withPlatformAdminContext tx is passed. If passed, tx must be on a privileged connection
 * (e.g., prior to SET LOCAL ROLE).
 */
export async function recordPlatformAdminAction(
  input: RecordPlatformAdminActionInput,
  tx: DbOrTx = db,
): Promise<void> {
  if (tx !== db && typeof tx.execute === "function") {
    const rows = await tx.execute<{ current_user: string }>(
      sql`SELECT current_user`,
    );
    const role = rows[0]?.current_user;
    if (role === "platform_admin_role") {
      throw new Error(
        "recordPlatformAdminAction cannot be called within platform_admin_role context (platform_admin_role has SELECT only on platform_admin_audit_log)",
      );
    }
  }

  await tx.insert(platformAdminAuditLog).values({
    actorSub: input.actorSub,
    action: input.action,
    targetTenantId: input.targetTenantId,
  });
}

export interface PlatformAdminAuditEntryView {
  id: string;
  actorSub: string;
  action: PlatformAdminAction;
  targetTenantId: string;
  createdAt: string;
}

function asPlatformAdminAction(action: string): PlatformAdminAction {
  if (
    action === "sandbox.created" ||
    action === "sandbox.reset" ||
    action === "sandbox.deleted" ||
    action === "sandbox.trial_changed" ||
    action === "sandbox.trial_ended"
  )
    return action;
  // The DB CHECK constraint (migrations 0141, 0142) already guarantees this is unreachable --
  // narrowing defensively, same pattern as platform-admin-view.ts's asProgressStatus.
  throw new Error(`unexpected platform_admin_audit_log.action: ${action}`);
}

export interface ListPlatformAdminAuditLogOptions {
  limit: number;
  /** Row id to page from — results are strictly older than this row's created_at. */
  before?: string | undefined;
  /** Narrows the log to one tenant's actions (the dashboard's per-tenant timeline). */
  targetTenantId?: string | undefined;
}

/**
 * Newest-first, keyset-paginated by created_at (not offset -- this table only grows, and an
 * offset page can skip/duplicate rows as new entries are inserted between requests).
 */
export async function listPlatformAdminAuditLog(
  options: ListPlatformAdminAuditLogOptions,
): Promise<PlatformAdminAuditEntryView[]> {
  const tenantFilter = options.targetTenantId
    ? eq(platformAdminAuditLog.targetTenantId, options.targetTenantId)
    : undefined;
  const rows = await withPlatformAdminContext(async (tx) => {
    if (!options.before) {
      return tx
        .select()
        .from(platformAdminAuditLog)
        .where(tenantFilter)
        .orderBy(
          desc(platformAdminAuditLog.createdAt),
          desc(platformAdminAuditLog.id),
        )
        .limit(options.limit);
    }
    // Keyset pagination on the (created_at DESC, id DESC) total order (#894). The cursor row is
    // read inside the query, not into JavaScript first: a JS Date holds milliseconds while
    // created_at holds microseconds, so a cursor read back through one would be truncated and
    // the rows between the truncated and the real value would match neither side of the
    // predicate and be skipped (#993). A cursor id that does not exist gives NULL, so no rows.
    return tx
      .select()
      .from(platformAdminAuditLog)
      .where(
        and(
          sql`(${platformAdminAuditLog.createdAt}, ${platformAdminAuditLog.id}) < (select ${platformAdminAuditLog.createdAt}, ${platformAdminAuditLog.id} from ${platformAdminAuditLog} where ${platformAdminAuditLog.id} = ${options.before})`,
          tenantFilter,
        ),
      )
      .orderBy(
        desc(platformAdminAuditLog.createdAt),
        desc(platformAdminAuditLog.id),
      )
      .limit(options.limit);
  });

  return rows.map((row) => ({
    id: row.id,
    actorSub: row.actorSub,
    action: asPlatformAdminAction(row.action),
    targetTenantId: row.targetTenantId,
    createdAt: row.createdAt.toISOString(),
  }));
}
