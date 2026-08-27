/**
 * access-log-retention.ts
 *
 * ADR-012 Phase G, spec R8 -- recurring sweep (daily, matching the pattern
 * established by attachment-cleanup.ts's own recurring BullMQ job) that
 * removes `admin_audit_log` detail rows older than 90 days, while their
 * aggregate counts survive in `admin_audit_log_daily_rollup` (per tenant,
 * day, resource type, action -- "outcome" is derived from `action` at read
 * time via @platform/audit's classifyOutcome, never stored).
 *
 * Each batch aggregates-then-deletes inside a single SQL statement (three
 * chained CTEs) so the rollup upsert and the detail-row delete are atomic
 * per batch -- a crash between them is not possible within one statement,
 * unlike a separate SELECT+INSERT+DELETE round-trip from application code.
 * Raw SQL is used deliberately here (db-conventions.md's documented
 * exception): a Drizzle query builder has no ergonomic way to express
 * "aggregate a batch, upsert the aggregate, delete the same batch" as one
 * atomic unit.
 */

import { sql } from "drizzle-orm";
import { db } from "@platform/db";
import { logger } from "@platform/logger";
import { Worker, Queue } from "bullmq";
import { connection } from "./queues.js";

const QUEUE_NAME = "access-log-retention";
const RETENTION_DAYS = 90;
/** Max rows aggregated+deleted per batch -- bounds one run's lock/memory footprint. */
const BATCH_LIMIT = 5000;

/**
 * Runs batches until a run finds nothing left to sweep, or hits
 * MAX_BATCHES_PER_RUN (a sustained backlog is swept over multiple daily
 * runs rather than risking one run holding locks indefinitely).
 */
const MAX_BATCHES_PER_RUN = 20;

// No withTenantContext/explicit tenant_id filter here -- same accepted
// pattern as attachment-cleanup.ts's own cross-tenant sweep. This worker
// runs under the privileged DB connection (not the app_user RLS role), so
// admin_audit_log's RLS policies do not restrict these reads or deletes;
// every write targets only rows older than the retention window, not
// per-tenant row contents, so there is no cross-tenant data exposure.
async function runOneBatch(): Promise<number> {
  // MATERIALIZED forces Postgres to compute `batch` once and reuse that
  // exact row set for both the aggregate and the delete -- without it, a
  // multiply-referenced CTE can be inlined differently per reference on
  // some plans, which would risk aggregating one row set and deleting a
  // slightly different one.
  const rows = await db.execute<{ deleted_count: number }>(sql`
    WITH batch AS MATERIALIZED (
      SELECT id, tenant_id, resource_type, action, date_trunc('day', created_at)::date AS day
      FROM admin_audit_log
      WHERE created_at < now() - (${RETENTION_DAYS} || ' days')::interval
      ORDER BY created_at
      LIMIT ${BATCH_LIMIT}
    ),
    agg AS (
      SELECT tenant_id, day, resource_type, action, count(*) AS cnt
      FROM batch
      GROUP BY tenant_id, day, resource_type, action
    ),
    upsert AS (
      INSERT INTO admin_audit_log_daily_rollup (tenant_id, day, resource_type, action, count)
      SELECT tenant_id, day, resource_type, action, cnt FROM agg
      ON CONFLICT (tenant_id, day, resource_type, action)
      DO UPDATE SET count = admin_audit_log_daily_rollup.count + excluded.count
      RETURNING 1
    ),
    deleted AS (
      DELETE FROM admin_audit_log WHERE id IN (SELECT id FROM batch)
      RETURNING 1
    )
    SELECT count(*)::int AS deleted_count FROM deleted
  `);

  return rows[0]?.deleted_count ?? 0;
}

export async function runAccessLogRetentionSweep(): Promise<void> {
  let totalDeleted = 0;
  for (let batchNum = 0; batchNum < MAX_BATCHES_PER_RUN; batchNum++) {
    const deleted = await runOneBatch();
    totalDeleted += deleted;
    if (deleted < BATCH_LIMIT) {
      // Last batch was partial (or empty) -- nothing older than the
      // retention window remains right now.
      break;
    }
  }
  logger.info(
    { totalDeleted, retentionDays: RETENTION_DAYS },
    "access-log-retention: sweep complete",
  );
}

export const accessLogRetentionWorker = new Worker(
  QUEUE_NAME,
  async () => {
    await runAccessLogRetentionSweep();
  },
  { connection },
);

accessLogRetentionWorker.on("failed", (_job, err) => {
  logger.error({ err: String(err) }, "access-log-retention: worker job failed");
});

/**
 * Schedule a recurring sweep (daily at 03:00 -- an idle-hours slot, matching
 * this codebase's convention of running batch jobs outside peak traffic).
 */
export async function scheduleAccessLogRetention(): Promise<void> {
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.add(
    "sweep",
    {},
    {
      repeat: { pattern: "0 3 * * *" },
      jobId: "access-log-retention-recurring",
    },
  );
  await queue.close();
  logger.info(
    {},
    "access-log-retention: recurring job scheduled (daily 03:00)",
  );
}

export async function stopAccessLogRetentionWorker(): Promise<void> {
  await accessLogRetentionWorker.close();
}
