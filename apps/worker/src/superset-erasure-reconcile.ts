/**
 * superset-erasure-reconcile.ts
 *
 * Repeatable BullMQ worker sweep (runs every 5 minutes) that reconciles unqueued or
 * dropped Superset erasures and reports the ones still open (#1138, #1141, ADR-019 Stage 2 blocker).
 *
 * Problem:
 * When DELETE /users/:userId commits in the API, it erases user data from the OpenWind DB
 * and writes a `deleted` audit entry for the user. If the subsequent enqueue to the
 * `superset-erasure` queue fails (Redis transient error or process crash between commit
 * and enqueue), the erasure job in Superset is never queued. Repeating the API call fails
 * with NOT_FOUND because the user has already been removed from the tenant. A tenant purge
 * (`purge.completed`) has the same gap.
 *
 * Solution:
 * Every 5 minutes, if Superset erasure mode is "full":
 * 1. Sweep active tenants via `listSweepTenants()` and `forEachTenant()` under `withTenantContext()`.
 * 2. Select `admin_audit_log` rows, oldest first, within the last MONITOR_WINDOW_DAYS (90) days:
 *      - a user `deleted` row with `metadata->>'wasMember' = 'true'` (pre-Stage-2 rows lack it), or
 *      - a tenant `purge.completed` row (no Stage-2 bound exists for these: the first full-mode
 *        sweep after Stage 2 is enabled re-checks every purge in the window; Superset erasure is
 *        idempotent, see docs/runbooks/superset-erasure.md),
 *    that have no `superset_erasure.completed` sibling for the same resource, and, for a user row,
 *    no later `superset_erasure.completed` row for its tenant (a finished tenant erasure removes
 *    that tenant's Superset accounts).
 * 3. Re-enqueue each of them through `enqueueSupersetErasure()`, except a row that has a terminal
 *    `superset_erasure.failed` sibling (status other than `unverified`: the job spent its retries).
 *    Idempotency is guaranteed by `supersetErasureJobId()`: a job that is active/waiting is not
 *    re-enqueued.
 * 4. Increment `openwind_superset_erasure_total{outcome="reconciled"}` for newly re-queued jobs.
 * 5. Store, for Prometheus, the count of rows older than 1 hour and the oldest of them with their
 *    audit `created_at`. A terminally failed row is still counted: it has no `completed` record,
 *    and the age alerts (SupersetErasurePending7d, SupersetErasurePending25d) track it to the
 *    30-day target. A tenant whose sweep failed this round keeps its previous entries, so one
 *    transient error cannot make its erasures look resolved.
 */

import { Queue, Worker, supersetErasureTotal } from "@platform/telemetry";
import { env, supersetErasureMode } from "@platform/config";
import { logger } from "@platform/logger";
import { adminAuditLog, withTenantContext } from "@platform/db";
import { and, asc, eq, gte, or, sql, type SQL } from "drizzle-orm";
import {
  readSupersetSelfcheck,
  readSupersetUnreconciledCount,
  readSupersetUnreconciledEntries,
  resolveSupersetErasureMode,
  writeSupersetUnreconciled,
  type UnreconciledErasureEntry,
} from "@platform/redis";
import { connection, supersetErasureQueue } from "./queues.js";
import { cleanSupersetErasureFinishedJobs } from "./superset-erasure-failed-cleanup.js";
import {
  enqueueSupersetErasure,
  supersetErasureJobId,
} from "./superset-erasure.js";
import { forEachTenant, listSweepTenants } from "./tenant-sweep.js";

export const RECONCILE_QUEUE_NAME = "superset-erasure-reconcile";
export const RECONCILE_REPEAT_JOB_ID = "superset-erasure-reconcile-recurring";
export const RECONCILE_START_JOB_ID = "superset-erasure-reconcile-on-start";

/** Maximum rows to inspect per tenant sweep cycle, oldest first. */
export const BATCH_LIMIT = 500;

/**
 * How far back the sweep looks. The completion target is 30 days (GDPR Article 17); the extra 60
 * keep an erasure that missed it visible, and still being retried, instead of dropping out of the
 * sweep, and so out of the alerts, on day 30.
 */
export const MONITOR_WINDOW_DAYS = 90;

/**
 * A column of the outer admin_audit_log row, qualified by name. The correlated subqueries below alias
 * the same table, and drizzle renders an interpolated column in a select list without its table, so
 * an interpolated column there would resolve to the subquery's own row and match any sibling.
 */
const outer = (column: string): SQL => sql.raw(`admin_audit_log.${column}`);

export interface ReconcileTenantResult {
  reconciled: number;
  olderThan1h: number;
  entries: UnreconciledErasureEntry[];
}

export interface ReconcileSweepSummary {
  tenantCount: number;
  failedTenantCount: number;
  totalReconciled: number;
  totalOlderThan1h: number;
  skipped: boolean;
}

type OpenErasureRow = {
  id: string;
  resourceType: string;
  resourceId: string;
  metadata: unknown;
  createdAt: Date;
  terminalFailed: boolean;
};

type TenantTx = Parameters<Parameters<typeof withTenantContext>[1]>[0];

/**
 * The oldest open erasure rows of one tenant, split by whether a terminal `superset_erasure.failed`
 * row exists for the same resource. Only reads: callers act on the result outside the transaction.
 */
async function selectOpenRows(
  tx: TenantTx,
  tenantId: string,
  cutoffWindow: Date,
  terminalFailed: boolean,
  limit: number,
): Promise<OpenErasureRow[]> {
  const hasTerminalFailure = sql<boolean>`EXISTS (
    SELECT 1 FROM admin_audit_log failed
    WHERE failed.tenant_id = ${outer("tenant_id")}
      AND failed.resource_type = ${outer("resource_type")}
      AND failed.resource_id = ${outer("resource_id")}
      AND failed.action = 'superset_erasure.failed'
      AND (
        failed.metadata->>'status' IS NULL
        OR failed.metadata->>'status' != 'unverified'
      )
  )`;
  return tx
    .select({
      id: adminAuditLog.id,
      resourceType: adminAuditLog.resourceType,
      resourceId: adminAuditLog.resourceId,
      metadata: adminAuditLog.metadata,
      createdAt: adminAuditLog.createdAt,
      terminalFailed: hasTerminalFailure,
    })
    .from(adminAuditLog)
    .where(
      and(
        eq(adminAuditLog.tenantId, tenantId),
        gte(adminAuditLog.createdAt, cutoffWindow),
        or(
          and(
            eq(adminAuditLog.resourceType, "user"),
            eq(adminAuditLog.action, "deleted"),
            sql`${adminAuditLog.metadata}->>'wasMember' = 'true'`,
          ),
          and(
            eq(adminAuditLog.resourceType, "tenant"),
            eq(adminAuditLog.action, "purge.completed"),
          ),
        ),
        sql`NOT EXISTS (
          SELECT 1 FROM admin_audit_log sibling
          WHERE sibling.tenant_id = ${outer("tenant_id")}
            AND sibling.action = 'superset_erasure.completed'
            AND (
              (
                sibling.resource_type = ${outer("resource_type")}
                AND sibling.resource_id = ${outer("resource_id")}
              )
              OR (
                ${outer("resource_type")} = 'user'
                AND sibling.resource_type = 'tenant'
                AND sibling.created_at >= ${outer("created_at")}
              )
            )
        )`,
        terminalFailed ? hasTerminalFailure : sql`NOT ${hasTerminalFailure}`,
      ),
    )
    .orderBy(asc(adminAuditLog.createdAt))
    .limit(limit);
}

/**
 * Sweeps a single tenant's audit log for unreconciled deleted user or tenant purge rows and re-enqueues them (#1138, #1141).
 * Reads are executed inside withTenantContext(tenantId) to respect ADR-001 RLS without BYPASSRLS.
 */
export async function reconcileTenantSupersetErasure(
  tenantId: string,
  now: Date,
  options: { force?: boolean; batchLimit?: number } = {},
): Promise<ReconcileTenantResult> {
  const batchLimit = options.batchLimit ?? BATCH_LIMIT;
  const cutoffWindow = new Date(
    now.getTime() - MONITOR_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const cutoff1h = new Date(now.getTime() - 60 * 60 * 1000);

  // 1. Fetch unreconciled user deletion or tenant purge audit rows under tenant context.
  // Terminally failed rows are never re-queued but stay for the whole window, so they are read
  // separately: a pile of them must not fill the batch and starve the rows that still need a retry.
  const rows = await withTenantContext(tenantId, async (tx) => {
    const retryable = await selectOpenRows(
      tx,
      tenantId,
      cutoffWindow,
      false,
      batchLimit,
    );
    const terminal = await selectOpenRows(
      tx,
      tenantId,
      cutoffWindow,
      true,
      batchLimit,
    );
    for (const [kind, found] of [
      ["retryable", retryable],
      ["terminally failed", terminal],
    ] as const) {
      if (found.length === batchLimit) {
        logger.warn(
          { tenantId, kind, batchLimit },
          "superset-erasure-reconcile: batch limit reached; the oldest rows were processed first and the count may undercount",
        );
      }
    }
    return [...retryable, ...terminal].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  });

  let reconciled = 0;
  let olderThan1h = 0;
  const entries: UnreconciledErasureEntry[] = [];

  // 2. Process enqueues outside of the DB transaction
  for (const row of rows) {
    if (row.createdAt < cutoff1h) {
      olderThan1h += 1;
      entries.push({
        tenantId,
        subjectHash: row.resourceId,
        createdAt: row.createdAt.getTime(),
      });
    }

    // Spent its retries: counted above so it stays visible, but never re-enqueued.
    if (row.terminalFailed) continue;

    if (row.resourceType === "tenant") {
      const jobId = supersetErasureJobId({ kind: "tenant", tenantId });
      const existing = await supersetErasureQueue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state !== "failed" && state !== "completed") {
          continue;
        }
      }
      const enqueued = await enqueueSupersetErasure(
        { kind: "tenant", tenantId },
        options.force ? { force: true } : {},
      );
      if (enqueued) {
        supersetErasureTotal.add(1, { outcome: "reconciled" });
        reconciled += 1;
      }
      continue;
    }

    const meta = row.metadata as Record<string, unknown> | null;
    const subject = typeof meta?.userId === "string" ? meta.userId : null;
    if (!subject) {
      logger.warn(
        { tenantId, auditId: row.id, resourceId: row.resourceId },
        "superset-erasure-reconcile: deleted user audit row has no valid metadata.userId; skipping",
      );
      continue;
    }

    const jobId = supersetErasureJobId({ kind: "user", tenantId, subject });
    const existing = await supersetErasureQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== "failed" && state !== "completed") {
        logger.info(
          { tenantId, subject, jobId, state },
          "superset-erasure-reconcile: job already in queue and active; skipping re-enqueue",
        );
        continue;
      }
    }

    const enqueued = await enqueueSupersetErasure(
      { kind: "user", tenantId, subject },
      options.force ? { force: true } : {},
    );
    if (enqueued) {
      supersetErasureTotal.add(1, { outcome: "reconciled" });
      reconciled += 1;
      logger.info(
        { tenantId, subject, jobId },
        "superset-erasure-reconcile: successfully enqueued erasure job",
      );
    }
  }

  return { reconciled, olderThan1h, entries };
}

/**
 * Runs the full reconciliation sweep across all tenants.
 * Only executes when Superset erasure mode is "full".
 */
export async function runSupersetErasureReconcile(): Promise<ReconcileSweepSummary> {
  // Before the mode check: a finished job's payload must not outlive its retention in any mode.
  try {
    await cleanSupersetErasureFinishedJobs(supersetErasureQueue);
  } catch (err) {
    logger.error(
      { err: String(err) },
      "superset-erasure-reconcile: finished-job cleanup failed",
    );
  }

  const localMode = supersetErasureMode(env);
  const selfcheck = await readSupersetSelfcheck();
  const { mode, overridden } = resolveSupersetErasureMode(localMode, selfcheck);

  if (mode !== "full") {
    logger.debug(
      { localMode, mode },
      "superset-erasure-reconcile: skipped because Superset erasure mode is not full",
    );
    await writeSupersetUnreconciled(0, []);
    return {
      tenantCount: 0,
      failedTenantCount: 0,
      totalReconciled: 0,
      totalOlderThan1h: 0,
      skipped: true,
    };
  }

  const now = new Date();
  const sweepTenants = await listSweepTenants();
  const { results, failedTenantIds } = await forEachTenant(
    "superset-erasure-reconcile",
    sweepTenants.map((t) => t.id),
    (tenantId) =>
      reconcileTenantSupersetErasure(
        tenantId,
        now,
        overridden ? { force: true } : {},
      ),
  );

  let totalReconciled = 0;
  let totalOlderThan1h = 0;
  const allEntries: UnreconciledErasureEntry[] = [];
  for (const res of results.values()) {
    totalReconciled += res.reconciled;
    totalOlderThan1h += res.olderThan1h;
    allEntries.push(...res.entries);
  }

  // A tenant that could not be swept this round keeps what the last sweep knew about it; leaving
  // it out would make its open erasures read as completed and reset their alerts. Without a
  // previous snapshot there is nothing to keep, so nothing is published: the gauges then hold
  // their last values until a clean sweep.
  if (failedTenantIds.length > 0) {
    const previous = await readSupersetUnreconciledEntries();
    if (previous === null) {
      logger.warn(
        { failedTenants: failedTenantIds.length },
        "superset-erasure-reconcile: tenants failed and no previous snapshot to carry; not publishing this round",
      );
      return {
        tenantCount: sweepTenants.length,
        failedTenantCount: failedTenantIds.length,
        totalReconciled,
        totalOlderThan1h,
        skipped: false,
      };
    }
    const failed = new Set(failedTenantIds);
    const carried = previous.filter((e) => failed.has(e.tenantId));
    allEntries.push(...carried);
    // The stored list is capped, so what it carries can undercount; the previous total is the
    // safer floor (it can only overstate, by what completed since).
    totalOlderThan1h = Math.max(
      totalOlderThan1h + carried.length,
      (await readSupersetUnreconciledCount()) ?? 0,
    );
  }

  await writeSupersetUnreconciled(totalOlderThan1h, allEntries);

  logger.info(
    {
      tenantCount: sweepTenants.length,
      failedTenants: failedTenantIds.length,
      reconciled: totalReconciled,
      olderThan1h: totalOlderThan1h,
    },
    "superset-erasure-reconcile: sweep complete",
  );

  return {
    tenantCount: sweepTenants.length,
    failedTenantCount: failedTenantIds.length,
    totalReconciled,
    totalOlderThan1h,
    skipped: false,
  };
}

export const supersetErasureReconcileWorker = new Worker(
  RECONCILE_QUEUE_NAME,
  async () => {
    await runSupersetErasureReconcile();
  },
  { connection },
);

supersetErasureReconcileWorker.on("failed", (_job, err) => {
  logger.error(
    { err: String(err) },
    "superset-erasure-reconcile: worker job failed",
  );
});

/**
 * Registers the repeatable sweep job (every 5 minutes) and adds a one-off run at startup.
 * Idempotent.
 */
export async function scheduleSupersetErasureReconcile(): Promise<void> {
  const queue = new Queue(RECONCILE_QUEUE_NAME, { connection });
  try {
    await queue.add(
      "reconcile",
      {},
      {
        repeat: { pattern: "*/5 * * * *" },
        jobId: RECONCILE_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    await queue.add(
      "reconcile-on-start",
      {},
      {
        jobId: RECONCILE_START_JOB_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    logger.info(
      {},
      "superset-erasure-reconcile: recurring job scheduled (every 5m + on start)",
    );
  } finally {
    await queue.close();
  }
}

export async function stopSupersetErasureReconcileWorker(): Promise<void> {
  await supersetErasureReconcileWorker.close();
}
