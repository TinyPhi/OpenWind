/**
 * retention-archival.ts
 *
 * Stage 3 - Compliance (observability-compliance track, Issue #506)
 * Daily 04:00 sweep. Per-tenant windows and holds are resolved in
 * retention-policy.ts; deletes run per tenant under withTenantContext in
 * retention-sweep.ts (docs/specs/retention-classes.md).
 */

import { randomUUID } from "node:crypto";
import { ne } from "drizzle-orm";
import { db, tenants } from "@platform/db";
import { logger } from "@platform/logger";
import { Worker, Queue } from "bullmq";
import { connection } from "./queues.js";
import { getRedis } from "@platform/redis";
import { isTenantTrialActive } from "@platform/auth";
import { resolveRetentionPolicy } from "./retention-policy.js";
import { sweepTenant } from "./retention-sweep.js";
import { env } from "@platform/config";
import { deleteExpiredUserDataExports } from "@platform/files";

const QUEUE_NAME = "retention-archival";

const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export async function runRetentionArchivalSweep(): Promise<void> {
  const redis = getRedis();
  const lockKey = "lock:retention-archival-sweep";
  const lockToken = randomUUID();
  const acquired = await redis.set(lockKey, lockToken, "EX", 3600, "NX");
  if (!acquired) {
    logger.info(
      {},
      "retention-archival: sweep already running on another instance, skipping",
    );
    return;
  }

  try {
    logger.info({}, "retention-archival: starting daily cleanup sweep");

    // 1. Get all active tenants
    const allTenants = await db
      .select({
        id: tenants.id,
        config: tenants.config,
        trialEndsAt: tenants.trialEndsAt,
      })
      .from(tenants)
      .where(ne(tenants.status, "deleted"));

    // T12 (docs/specs/multi-org-sandbox.md R6): an expired sandbox trial stops
    // background jobs too, checked fresh against Date.now() every sweep.
    const activeTenants = allTenants.filter((tenant) =>
      isTenantTrialActive(tenant.trialEndsAt?.getTime() ?? null),
    );

    logger.info(
      { tenantCount: activeTenants.length },
      `retention-archival: found ${activeTenants.length} tenants to evaluate`,
    );

    for (const tenant of activeTenants) {
      const tenantId = tenant.id;
      const policy = resolveRetentionPolicy(tenant.config);

      // Data-subject export files (docs/specs/user-data-export.md) are transient
      // copies of personal data, so a retention hold does not keep them.
      try {
        const removed = await deleteExpiredUserDataExports(
          tenantId,
          env.USER_EXPORT_TTL_DAYS * 86_400_000,
        );
        if (removed > 0) {
          logger.info(
            { tenantId, removed },
            "retention-archival: deleted expired user-data export files",
          );
        }
      } catch (err) {
        logger.error(
          { err, tenantId },
          "retention-archival: failed to delete expired user-data exports",
        );
      }

      if (policy.hold) {
        logger.info(
          { tenantId },
          "retention-archival: tenant is under retention hold, skipping",
        );
        continue;
      }

      try {
        const result = await sweepTenant(tenantId, policy);
        logger.info(
          { tenantId, ...policy, ...result },
          "retention-archival: swept tenant",
        );
      } catch (err) {
        logger.error(
          { err, tenantId },
          "retention-archival: failed to process sweep for tenant",
        );
      }
    }

    logger.info({}, "retention-archival: daily cleanup sweep complete");
  } finally {
    // Only the owner releases: a sweep that outlived the TTL must not delete the lock a
    // later instance took over.
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken);
  }
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
