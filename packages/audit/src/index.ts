/**
 * @platform/audit
 *
 * Append-only audit log for all entity mutations.
 * Writes to `admin_audit_log` in the same DB transaction as the mutation.
 *
 * PII invariant: before_snapshot and after_snapshot are redacted using the
 * same `redactMetadata` + `buildSensitivityMap` logic as the workflow engine.
 * This ensures that sensitive field values are never stored verbatim in the
 * audit log, even if they appear in entity field values.
 *
 * Usage:
 *   await writeAuditEntry(tx, {
 *     tenantId, actorId, actorType: 'user',
 *     resourceType: 'ticket', resourceId: instance.id,
 *     action: 'created',
 *     afterSnapshot: instance.fields,
 *     entityFields: allFields,  // for redaction
 *   });
 *
 * Call this inside the same transaction as the entity mutation.
 */

import {
  eq,
  desc,
  and,
  ne,
  or,
  isNotNull,
  gte,
  lte,
  lt,
  inArray,
  sql,
} from "drizzle-orm";
import type { Db, DbOrTx } from "@platform/db";
import { adminAuditLog } from "@platform/db";
import { logger } from "@platform/logger";
import {
  redactMetadata,
  buildSensitivityMap,
  type FieldSensitivity,
} from "@platform/workflow-engine";

export {
  classifyOutcome,
  actionsForOutcome,
  type AuditOutcome,
} from "./outcome.js";
import { actionsForOutcome, type AuditOutcome } from "./outcome.js";

export type AuditActorType = "user" | "api_key" | "system";
export type AuditAction =
  | "created"
  | "updated"
  | "deleted"
  | "transitioned"
  | "restored"
  | "purge.completed"
  | "purge.failed"
  // ADR-012 Phase C, spec R6/R7 — third-party API tag-resolution outcomes and
  // the tagging-driven auto-grant rate cap. Interim sink until Phase F's
  // Access Logs screen exists to read these (see the Phase C spec's §C
  // "new schema" row) — no new table, just new action strings.
  | "tag.resolved_existing_access"
  | "tag.auto_granted"
  | "tag.access_request_created"
  | "tag.fallback"
  | "tag.resolution_failed"
  | "tag.misuse_rate_capped"
  // ADR-012 Phase D, spec R5 — an AV scan quarantining or failing a file
  // backing a bound third-party attachment. DB CHECK constraint extended in
  // the SAME migration that adds these (0077) -- see that file's comment for
  // why this is a hard rule now, not a suggestion (Phase C's B1 incident).
  | "attachment.quarantined"
  | "attachment.scan_failed"
  // ADR-012 Phase E, spec R3 — third-party status-transition attempts,
  // migration 0080_admin_audit_log_transition_actions.sql extends the DB
  // CHECK constraint in the same commit.
  | "transition.executed"
  | "transition.access_denied"
  // ADR-012 Phase F, spec AC4 — retrofits comments.ts/children.ts/
  // attachments-reference.ts (previously unaudited) onto the same
  // atomic-write pattern transitions.ts established. Migration
  // 0081_admin_audit_log_comment_child_attachment_actions.sql extends the
  // DB CHECK constraint in the same commit.
  | "comment.created"
  | "comment.access_denied"
  | "child.created"
  | "child.access_denied"
  | "attachment.referenced"
  | "attachment.reference_denied";

export type AuditEntryInput = {
  tenantId: string;
  actorId: string;
  actorType: AuditActorType;
  /** ADR-012 Phase B spec R9/GAP-05 — the real person acting through a third-party API key (actorId/actorType above), distinct identity so search-by-person and search-by-key both work independently. Omit for every non-third-party actor. */
  actingPersonId?: string | undefined;
  resourceType: string;
  resourceId: string;
  action: AuditAction;
  /** Raw field values before mutation — will be redacted for pii/financial fields */
  beforeSnapshot?: Record<string, unknown> | null | undefined;
  /** Raw field values after mutation — will be redacted for pii/financial fields */
  afterSnapshot?: Record<string, unknown> | null | undefined;
  /** Additional context (e.g. transition name, bulk batch id) */
  metadata?: Record<string, unknown> | null | undefined;
  /**
   * Field definitions for the mutated entity type.
   * Used to build the sensitivity map for redaction.
   * If omitted, no redaction is applied (safe fallback for non-entity audits).
   */
  entityFields?: ReadonlyArray<{
    name: string;
    sensitivity: FieldSensitivity;
  }>;
};

/**
 * Write an audit entry in the same transaction as the mutation it describes.
 *
 * Redacts pii/financial field values from before_snapshot and after_snapshot
 * before persisting. Field names are always retained.
 */
export async function writeAuditEntry(
  db: DbOrTx,
  input: AuditEntryInput,
): Promise<void> {
  const sensitivityMap = input.entityFields
    ? buildSensitivityMap(input.entityFields)
    : new Map<string, FieldSensitivity>();

  const beforeSnapshot =
    input.beforeSnapshot !== null && input.beforeSnapshot !== undefined
      ? redactMetadata(input.beforeSnapshot, sensitivityMap)
      : null;

  const afterSnapshot =
    input.afterSnapshot !== null && input.afterSnapshot !== undefined
      ? redactMetadata(input.afterSnapshot, sensitivityMap)
      : null;

  await db.insert(adminAuditLog).values({
    tenantId: input.tenantId,
    actorId: input.actorId,
    actorType: input.actorType,
    actingPersonId: input.actingPersonId ?? null,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    action: input.action,
    beforeSnapshot: beforeSnapshot,
    afterSnapshot: afterSnapshot,
    metadata: input.metadata ?? null,
  });

  logger.info(
    {
      tenantId: input.tenantId,
      actorId: input.actorId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      action: input.action,
    },
    "audit: entry written",
  );
}

// ── Query ─────────────────────────────────────────────────────────────────────

export type AuditLogEntry = {
  id: string;
  tenantId: string;
  actorId: string;
  actorType: AuditActorType;
  actingPersonId: string | null;
  resourceType: string;
  resourceId: string;
  action: AuditAction;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

export type QueryAuditLogInput = {
  tenantId: string;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  /** Admin-UI API Keys card view — an "application" can span multiple key
   * rows (rotations), so its access-log filter needs to match any one of
   * several actorIds, not just a single exact key. */
  actorId?: string | string[] | undefined;
  actorType?: AuditActorType | undefined;
  /** ADR-012 Phase F — the real person acting through a third-party API key, distinct from actorId (the key itself). */
  actingPersonId?: string | undefined;
  /** ADR-012 Phase F — outcome is derived (see classifyOutcome), not stored; this filters by the set of AuditAction values that classify to the given outcome. */
  outcome?: AuditOutcome | undefined;
  /** Filter entries created at or after this timestamp */
  from?: Date | undefined;
  /** Filter entries created at or before this timestamp */
  to?: Date | undefined;
  limit?: number | undefined;
  /**
   * Cursor-based pagination — pass the `id` of the last entry returned by the
   * previous page.  Results strictly after (createdAt less than) the cursor
   * entry are returned.
   */
  cursor?: string | undefined;
};

export type QueryAuditLogResult = {
  entries: AuditLogEntry[];
  nextCursor: string | null;
};

/**
 * Query the audit log for a tenant. Always scoped to tenantId via explicit
 * WHERE clause (layer-1 isolation). Caller must also ensure the db/tx is
 * operating under the correct tenant context.
 *
 * Supports filtering by actorId, actorType, resourceType, resourceId,
 * date range (from/to), and cursor-based pagination (cursor = last row id).
 */
export async function queryAuditLog(
  db: DbOrTx,
  input: QueryAuditLogInput,
): Promise<QueryAuditLogResult> {
  const limit = input.limit ?? 50;

  // Build WHERE conditions
  type Condition = ReturnType<typeof eq>;
  const conditions: Condition[] = [eq(adminAuditLog.tenantId, input.tenantId)];

  if (input.actorId !== undefined) {
    conditions.push(
      Array.isArray(input.actorId)
        ? inArray(adminAuditLog.actorId, input.actorId)
        : eq(adminAuditLog.actorId, input.actorId),
    );
  }
  if (input.actorType !== undefined)
    conditions.push(eq(adminAuditLog.actorType, input.actorType));
  if (input.resourceType !== undefined)
    conditions.push(eq(adminAuditLog.resourceType, input.resourceType));
  if (input.resourceId !== undefined)
    conditions.push(eq(adminAuditLog.resourceId, input.resourceId));
  if (input.actingPersonId !== undefined)
    conditions.push(eq(adminAuditLog.actingPersonId, input.actingPersonId));
  if (input.outcome !== undefined)
    conditions.push(
      inArray(adminAuditLog.action, actionsForOutcome(input.outcome)),
    );
  if (input.from !== undefined)
    conditions.push(gte(adminAuditLog.createdAt, input.from));
  if (input.to !== undefined)
    conditions.push(lte(adminAuditLog.createdAt, input.to));

  // Cursor pagination: resolve the cursor id to a createdAt timestamp,
  // then return entries with createdAt strictly before that point
  // (consistent with DESC order).
  if (input.cursor !== undefined) {
    const [cursorRow] = await db
      .select({ createdAt: adminAuditLog.createdAt })
      .from(adminAuditLog)
      .where(eq(adminAuditLog.id, input.cursor))
      .limit(1);

    if (cursorRow !== undefined) {
      conditions.push(lt(adminAuditLog.createdAt, cursorRow.createdAt));
    }
  }

  const rows = await db
    .select()
    .from(adminAuditLog)
    .where(and(...(conditions as [Condition, ...Condition[]])))
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const entries = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    actorId: r.actorId,
    actorType: r.actorType as AuditActorType,
    actingPersonId: r.actingPersonId,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    action: r.action as AuditAction,
    beforeSnapshot: r.beforeSnapshot as Record<string, unknown> | null,
    afterSnapshot: r.afterSnapshot as Record<string, unknown> | null,
    metadata: r.metadata as Record<string, unknown> | null,
    createdAt: r.createdAt,
  }));

  const nextCursor =
    hasMore && entries.length > 0
      ? (entries[entries.length - 1]?.id ?? null)
      : null;

  return { entries, nextCursor };
}

/** Placeholder written over person-identifying fields on purge (spec R9).
 *  Uses the same "[REDACTED]" sentinel as PII field redaction (migration 0009)
 *  so dashboards and analytics queries need only one exclusion pattern. */
const PURGED_PERSON_PLACEHOLDER = "[REDACTED]";

/**
 * ADR-012 Phase G, spec R9 -- a tenant purge immediately anonymizes (never
 * deletes) that tenant's admin_audit_log rows: person-identifying fields
 * are replaced with a fixed placeholder, while action/resourceType/
 * resourceId/createdAt (and therefore the derived outcome) are preserved
 * and remain queryable. Only `actorId` on actorType='user' rows is a person
 * identifier -- on 'api_key' rows actorId is the api_keys row id (an
 * application identity, not a person) and is left untouched; actingPersonId
 * is always a real person identifier whenever set (ADR-012 Phase B,
 * GAP-05), regardless of actorType, so it's always anonymized when present.
 *
 * Called from apps/worker/src/tenant-purge.ts via plain `db` (not
 * withTenantContext) -- admin_audit_log's RLS grants app_user INSERT+SELECT
 * only (append-only invariant, migration 0011), so this UPDATE must run
 * under the worker's own privileged connection, the same way every other
 * admin_audit_log write in that file already does.
 */
export async function anonymizeAuditLogForTenant(
  db: Db,
  tenantId: string,
): Promise<void> {
  // Runtime assertion: ensure we are not running inside a tenant RLS transaction context.
  // Any failure of the check itself — not just "tenant is active" — must abort the function:
  // failing open here would silently run the UPDATE in exactly the scenario the guard prevents.
  let tenantSetting: string | null;
  try {
    const rlsContext = await db.execute<{ current_setting: string | null }>(
      sql`SELECT current_setting('app.tenant_id', true) as current_setting`,
    );
    tenantSetting = rlsContext[0]?.current_setting ?? null;
  } catch (err) {
    throw new Error(
      `anonymizeAuditLogForTenant: failed to verify RLS context before UPDATE: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (tenantSetting) {
    throw new Error(
      `anonymizeAuditLogForTenant: cannot execute UPDATE under active tenant RLS context (tenant: ${tenantSetting})`,
    );
  }

  const BATCH_SIZE = 1000;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    // Select the next batch of un-anonymized row IDs.
    const batch = await db
      .select({ id: adminAuditLog.id })
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.tenantId, tenantId),
          or(
            and(
              eq(adminAuditLog.actorType, "user"),
              ne(adminAuditLog.actorId, PURGED_PERSON_PLACEHOLDER),
            ),
            and(
              isNotNull(adminAuditLog.actingPersonId),
              ne(adminAuditLog.actingPersonId, PURGED_PERSON_PLACEHOLDER),
            ),
          ),
        ),
      )
      .limit(BATCH_SIZE);

    if (batch.length === 0) {
      break;
    }

    const ids = batch.map((row) => row.id);

    await db
      .update(adminAuditLog)
      .set({
        actorId: sql`CASE WHEN ${adminAuditLog.actorType} = 'user' THEN ${PURGED_PERSON_PLACEHOLDER} ELSE ${adminAuditLog.actorId} END`,
        actingPersonId: sql`CASE WHEN ${adminAuditLog.actingPersonId} IS NOT NULL THEN ${PURGED_PERSON_PLACEHOLDER} ELSE NULL END`,
      })
      .where(inArray(adminAuditLog.id, ids));
  }
}
