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

import { eq, desc, and, gte, lte, lt } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { adminAuditLog } from "@platform/db";
import { logger } from "@platform/logger";
import {
  redactMetadata,
  buildSensitivityMap,
  type FieldSensitivity,
} from "@platform/workflow-engine";

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
  // ADR-012 Phase E, spec R3 — third-party status-transition attempts,
  // migration 0078_admin_audit_log_transition_actions.sql extends the DB
  // CHECK constraint in the same commit.
  | "transition.executed"
  | "transition.access_denied";

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
  actorId?: string | undefined;
  actorType?: AuditActorType | undefined;
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

  if (input.actorId !== undefined)
    conditions.push(eq(adminAuditLog.actorId, input.actorId));
  if (input.actorType !== undefined)
    conditions.push(eq(adminAuditLog.actorType, input.actorType));
  if (input.resourceType !== undefined)
    conditions.push(eq(adminAuditLog.resourceType, input.resourceType));
  if (input.resourceId !== undefined)
    conditions.push(eq(adminAuditLog.resourceId, input.resourceId));
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
