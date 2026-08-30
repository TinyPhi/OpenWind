/**
 * retention-archival.ts
 *
 * Stage 3 - Compliance (observability-compliance track, Issue #506)
 * Sweeps the database daily at 04:00 to delete old workflow_events, outbox_events,
 * and tenant_usage_daily records older than tenant_config.retention_days (default 90).
 */

import { and, eq, lt, ne, sql, isNotNull } from "drizzle-orm";
import {
  db,
  tenants,
  workflowEvents,
  outboxEvents,
  tenantUsageDaily,
} from "@platform/db";
import { logger } from "@platform/logger";
import { Worker, Queue } from "bullmq";
import { connection } from "./queues.js";

const QUEUE_NAME = "retention-archival";
const DEFAULT_RETENTION_DAYS = 90;

export async function runRetentionArchivalSweep(): Promise<void> {
  logger.info({}, "retention-archival: starting daily cleanup sweep");

  // 1. Get all active tenants
  const activeTenants = await db
    .select({ id: tenants.id, config: tenants.config })
    .from(tenants)
    .where(ne(tenants.status, "deleted"));

  logger.info(
    { tenantCount: activeTenants.length },
    `retention-archival: found ${activeTenants.length} tenants to evaluate`,
  );

  for (const tenant of activeTenants) {
    const tenantId = tenant.id;
    const config = tenant.config as Record<string, unknown> | undefined;
    const retentionDays =
      typeof config?.retention_days === "number" && config.retention_days >= 1
        ? config.retention_days
        : DEFAULT_RETENTION_DAYS;

    try {
      logger.info(
        { tenantId, retentionDays },
        `retention-archival: sweeping data for tenant ${tenantId} older than ${retentionDays} days`,
      );

      // Delete old workflow events
      await db
        .delete(workflowEvents)
        .where(
          and(
            eq(workflowEvents.tenantId, tenantId),
            lt(
              workflowEvents.createdAt,
              sql`now() - (${retentionDays} || ' days')::interval`,
            ),
          ),
        );

      // Delete old outbox events (only if successfully delivered and notified)
      await db
        .delete(outboxEvents)
        .where(
          and(
            eq(outboxEvents.tenantId, tenantId),
            isNotNull(outboxEvents.deliveredAt),
            isNotNull(outboxEvents.notifiedDeliveredAt),
            lt(
              outboxEvents.createdAt,
              sql`now() - (${retentionDays} || ' days')::interval`,
            ),
          ),
        );

      // Delete old usage logs
      await db
        .delete(tenantUsageDaily)
        .where(
          and(
            eq(tenantUsageDaily.tenantId, tenantId),
            lt(
              tenantUsageDaily.usageDate,
              sql`(current_date - (${retentionDays} || ' days')::interval)::date`,
            ),
          ),
        );

      logger.info(
        {
          tenantId,
          retentionDays,
        },
        `retention-archival: successfully swept data for tenant ${tenantId}`,
      );
    } catch (err) {
      logger.error(
        { err, tenantId },
        `retention-archival: failed to process sweep for tenant ${tenantId}`,
      );
    }
  }

  logger.info({}, "retention-archival: daily cleanup sweep complete");
}

export const retentionArchivalWorker = new Worker(
  QUEUE_NAME,
  async () => {
    await runRetentionArchivalSweep();
  },
  { connection },
);

retentionArchivalWorker.on("failed", (_job, err) => {
  logger.error({ err: String(err) }, "retention-archival: worker job failed");
});

export async function scheduleRetentionArchival(): Promise<void> {
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.add(
    "sweep",
    {},
    {
      repeat: { pattern: "0 4 * * *" },
      jobId: "retention-archival-recurring",
    },
  );
  await queue.close();
  logger.info({}, "retention-archival: recurring job scheduled (daily 04:00)");
}

export async function stopRetentionArchivalWorker(): Promise<void> {
  await retentionArchivalWorker.close();
}
