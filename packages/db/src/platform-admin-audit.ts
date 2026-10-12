import { and, desc, eq, lt } from "drizzle-orm";
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
  | "sandbox.deleted";

export interface RecordPlatformAdminActionInput {
  actorSub: string;
  action: PlatformAdminAction;
  targetTenantId: string;
}

/**
 * Writes on the privileged `db` connection (not withPlatformAdminContext's SET LOCAL ROLE
 * platform_admin_role) -- platform_admin_role is granted SELECT only (migration 0140); the
 * three sandbox lifecycle workers that call this already run with full `db` access.
 */
export async function recordPlatformAdminAction(
  input: RecordPlatformAdminActionInput,
  tx: DbOrTx = db,
): Promise<void> {
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
    action === "sandbox.deleted"
  )
    return action;
  // The DB CHECK constraint (migration 0140) already guarantees this is unreachable --
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
        .orderBy(desc(platformAdminAuditLog.createdAt))
        .limit(options.limit);
    }
    const [cursor] = await tx
      .select({ createdAt: platformAdminAuditLog.createdAt })
      .from(platformAdminAuditLog)
      .where(eq(platformAdminAuditLog.id, options.before))
      .limit(1);
    if (!cursor) return [];
    return tx
      .select()
      .from(platformAdminAuditLog)
      .where(
        // Keyset pagination on a DESC-ordered timestamp: strictly less-than the cursor row's
        // own created_at. Ties (two rows with the identical timestamp) are rare enough for an
        // operator-facing audit log that an id tiebreaker isn't worth the extra complexity.
        and(
          lt(platformAdminAuditLog.createdAt, cursor.createdAt),
          tenantFilter,
        ),
      )
      .orderBy(desc(platformAdminAuditLog.createdAt))
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
