/**
 * reporting-audit-retention.ts
 *
 * ADR-019 Stage 2 criterion 14 (#1139) -- recurring sweep that removes
 * `reporting.*` rows in `admin_audit_log` older than the configured cap
 * (REPORTING_AUDIT_RETENTION_DAYS, default 90 days).
 *
 * Runs via the narrow `reporting_audit_retention_role` (migration 0164, matching
 * the pattern established by access_log_retention_role / migration 0158).
 * The role is NOT BYPASSRLS; its policies strictly confine it to action LIKE 'reporting.%'.
 */

import { sql } from "drizzle-orm";
import { env } from "@platform/config";
import { db, setReportingAuditRetentionRole } from "@platform/db";
import { logger } from "@platform/logger";

/** Max rows deleted per batch -- bounds lock/memory footprint. */
export const REPORTING_RETENTION_BATCH_LIMIT = 5000;

/** Max batches per run to prevent holding connections under extreme backlog. */
export const MAX_REPORTING_BATCHES_PER_RUN = 20;

export function getReportingAuditRetentionDays(): number {
  return env.REPORTING_AUDIT_RETENTION_DAYS;
}

export async function runOneReportingBatch(
  retentionDays: number,
): Promise<number> {
  return db.transaction(async (tx) => {
    await setReportingAuditRetentionRole(tx);
    const rows = await tx.execute<{ deleted_count: number }>(sql`
      WITH batch AS MATERIALIZED (
        SELECT id
        FROM admin_audit_log
        WHERE created_at < now() - (${retentionDays} || ' days')::interval
          AND action LIKE 'reporting.%'
        ORDER BY created_at
        LIMIT ${REPORTING_RETENTION_BATCH_LIMIT}
      ),
      deleted AS (
        DELETE FROM admin_audit_log WHERE id IN (SELECT id FROM batch)
        RETURNING 1
      )
      SELECT count(*)::int AS deleted_count FROM deleted
    `);

    return rows[0]?.deleted_count ?? 0;
  });
}

export async function runReportingAuditRetentionSweep(
  customDays?: number,
): Promise<number> {
  const days = customDays ?? getReportingAuditRetentionDays();
  let totalDeleted = 0;
  let hitBatchCap = true;
  for (let batchNum = 0; batchNum < MAX_REPORTING_BATCHES_PER_RUN; batchNum++) {
    const deleted = await runOneReportingBatch(days);
    totalDeleted += deleted;
    if (deleted < REPORTING_RETENTION_BATCH_LIMIT) {
      hitBatchCap = false;
      break;
    }
  }
  logger.info(
    { totalDeleted, retentionDays: days },
    "reporting-audit-retention: sweep complete",
  );
  if (hitBatchCap) {
    logger.warn(
      {
        totalDeleted,
        maxBatches: MAX_REPORTING_BATCHES_PER_RUN,
        batchLimit: REPORTING_RETENTION_BATCH_LIMIT,
      },
      "reporting-audit-retention: stopped at the batch cap, a backlog remains for the next run",
    );
  }
  return totalDeleted;
}
