/**
 * superset-erasure-reconcile.ts
 *
 * Repeatable BullMQ worker sweep (runs every 5 minutes) that reconciles unqueued or
 * dropped Superset user erasures (#1138, ADR-019 Stage 2 blocker).
 *
 * Problem:
 * When DELETE /users/:userId commits in the API, it erases user data from the OpenWind DB
 * and writes a `deleted` audit entry for the user. If the subsequent enqueue to the
 * `superset-erasure` queue fails (Redis transient error or process crash between commit
 * and enqueue), the erasure job in Superset is never queued. Repeating the API call fails
 * with NOT_FOUND because the user has already been removed from the tenant.
 *
 * Solution (Option A, approved):
 * Every 5 minutes, if Superset erasure mode is "full":
 * 1. Sweep active tenants via `listSweepTenants()` and `forEachTenant()` under `withTenantContext()`.
 * 2. Select `admin_audit_log` rows where:
 *      - `resource_type = 'user'`
 *      - `action = 'deleted'`
 *      - `created_at >= NOW() - INTERVAL '7 days'`
 *      - `metadata->>'wasMember' = 'true'` (pre-Stage-2 rows lack this, bounding them out)
 *      - NOT EXISTS sibling row with the same `resource_id` having:
 *          - `action = 'superset_erasure.completed'`, OR
 *          - `action = 'superset_erasure.failed'` AND `metadata->>'status' != 'unverified'`
 *            (terminal failure; unverified failure rows are retried when the check is green)
 * 3. Enqueue each unreconciled row via `enqueueSupersetErasure()`.
 *    Idempotency is guaranteed by `supersetErasureJobId()`: if the job is already active/waiting,
 *    it is not re-enqueued.
 * 4. Increment `openwind_superset_erasure_total{outcome="reconciled"}` for newly re-queued jobs.
 * 5. Count unreconciled rows older than 1 hour and store in Redis for the
 *    `openwind_superset_erasure_unreconciled_older_than_1h` observable gauge.
 */

import { Queue, Worker, supersetErasureTotal } from "@platform/telemetry";
import { env, supersetErasureMode } from "@platform/config";
import { logger } from "@platform/logger";
import { adminAuditLog, withTenantContext } from "@platform/db";
import { and, eq, gte, or, sql } from "drizzle-orm";
import {
  readSupersetSelfcheck,
  resolveSupersetErasureMode,
  writeSupersetUnreconciledEntries,
  type UnreconciledErasureEntry,
} from "@platform/redis";
import { connection, supersetErasureQueue } from "./queues.js";
import {
  enqueueSupersetErasure,
  supersetErasureJobId,
} from "./superset-erasure.js";
import { forEachTenant, listSweepTenants } from "./tenant-sweep.js";

export const RECONCILE_QUEUE_NAME = "superset-erasure-reconcile";
export const RECONCILE_REPEAT_JOB_ID = "superset-erasure-reconcile-recurring";
export const RECONCILE_START_JOB_ID = "superset-erasure-reconcile-on-start";

/** Maximum rows to inspect per tenant sweep cycle. */
export const BATCH_LIMIT = 500;

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

/**
 * Sweeps a single tenant's audit log for unreconciled deleted user or tenant purge rows and re-enqueues them (#1138, #1141).
 * Reads are executed inside withTenantContext(tenantId) to respect ADR-001 RLS without BYPASSRLS.
 */
export async function reconcileTenantSupersetErasure(
  tenantId: string,
  now: Date,
  options: { force?: boolean } = {},
): Promise<ReconcileTenantResult> {
  // Look back up to 30 days to cover the statutory GDPR Article 17 completion target (#1141).
  const cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const cutoff1h = new Date(now.getTime() - 60 * 60 * 1000);

  // 1. Fetch unreconciled user deletion or tenant purge audit rows under tenant context
  const rows = await withTenantContext(tenantId, async (tx) => {
    return tx
      .select({
        id: adminAuditLog.id,
        resourceType: adminAuditLog.resourceType,
        resourceId: adminAuditLog.resourceId,
        metadata: adminAuditLog.metadata,
        createdAt: adminAuditLog.createdAt,
      })
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.tenantId, tenantId),
          gte(adminAuditLog.createdAt, cutoff30d),
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
            WHERE sibling.tenant_id = ${adminAuditLog.tenantId}
              AND sibling.resource_type = ${adminAuditLog.resourceType}
              AND sibling.resource_id = ${adminAuditLog.resourceId}
              AND (
                sibling.action = 'superset_erasure.completed'
                OR (
                  sibling.action = 'superset_erasure.failed'
                  AND (
                    sibling.metadata->>'status' IS NULL
                    OR sibling.metadata->>'status' != 'unverified'
                  )
                )
              )
          )`,
        ),
      )
      .limit(BATCH_LIMIT);
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
      });
    }

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
  const localMode = supersetErasureMode(env);
  const selfcheck = await readSupersetSelfcheck();
  const { mode, overridden } = resolveSupersetErasureMode(localMode, selfcheck);

  if (mode !== "full") {
    logger.debug(
      { localMode, mode },
      "superset-erasure-reconcile: skipped because Superset erasure mode is not full",
    );
    await writeSupersetUnreconciledEntries([]);
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

  await writeSupersetUnreconciledEntries(allEntries);

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
