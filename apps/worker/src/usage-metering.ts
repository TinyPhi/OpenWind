import { ne, sql } from "drizzle-orm";
import { db, tenants, tenantUsageDaily } from "@platform/db";
import { logger } from "@platform/logger";
import { Worker, Queue } from "bullmq";
import { connection } from "./queues.js";
import { PLAN_LIMITS } from "@platform/config";
import type { PlanLimits } from "@platform/config";
import { getTenantUsedBytes } from "@platform/files";
import { listUserIdsWithRole } from "@platform/auth";
import { sendNotification } from "@platform/notifications";
import { getRedis } from "@platform/redis";

const QUEUE_NAME = "usage-metering";

export async function runUsageMeteringSweep(): Promise<void> {
  const redis = getRedis();
  const lockKey = "lock:usage-metering-sweep";
  const acquired = await redis.set(lockKey, "locked", "EX", 3600, "NX");
  if (!acquired) {
    logger.info(
      {},
      "usage-metering: sweep already running on another instance, skipping",
    );
    return;
  }

  try {
    // 1. Get all active tenants
    const activeTenants = await db
      .select({ id: tenants.id, plan: tenants.plan })
      .from(tenants)
      .where(ne(tenants.status, "deleted"));

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0] as string;

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0] as string;

    logger.info(
      { tenantCount: activeTenants.length },
      "usage-metering: starting daily usage metering sweep",
    );

    for (const tenant of activeTenants) {
      const tenantId = tenant.id;
      const plan = tenant.plan;
      const limits = (PLAN_LIMITS[plan] ?? PLAN_LIMITS.standard) as PlanLimits;

      try {
        // 2. Fetch storage usage
        const storageBytes = await getTenantUsedBytes(db, tenantId);

        // 3 + 4. Fetch yesterday's and today's Redis counters in one round trip
        const [rawYestApi, rawYestAi, rawTodayApi, rawTodayAi] =
          await redis.mget(
            `usage:${tenantId}:${yesterdayStr}:api_calls`,
            `usage:${tenantId}:${yesterdayStr}:ai_tokens`,
            `usage:${tenantId}:${todayStr}:api_calls`,
            `usage:${tenantId}:${todayStr}:ai_tokens`,
          );
        const yesterdayApi = parseInt(rawYestApi ?? "0", 10);
        const yesterdayAi = parseInt(rawYestAi ?? "0", 10);
        const todayApi = parseInt(rawTodayApi ?? "0", 10);
        const todayAi = parseInt(rawTodayAi ?? "0", 10);

        // 5. Flush to DB for yesterday
        await db
          .insert(tenantUsageDaily)
          .values([
            {
              tenantId,
              usageDate: yesterdayStr,
              metric: "api_calls",
              value: yesterdayApi,
            },
            {
              tenantId,
              usageDate: yesterdayStr,
              metric: "ai_tokens",
              value: yesterdayAi,
            },
            {
              tenantId,
              usageDate: yesterdayStr,
              metric: "storage_bytes",
              value: storageBytes,
            },
          ])
          .onConflictDoUpdate({
            target: [
              tenantUsageDaily.tenantId,
              tenantUsageDaily.usageDate,
              tenantUsageDaily.metric,
            ],
            set: { value: sql`excluded.value` },
          });

        // 6. Flush to DB for today (running totals)
        await db
          .insert(tenantUsageDaily)
          .values([
            {
              tenantId,
              usageDate: todayStr,
              metric: "api_calls",
              value: todayApi,
            },
            {
              tenantId,
              usageDate: todayStr,
              metric: "ai_tokens",
              value: todayAi,
            },
            {
              tenantId,
              usageDate: todayStr,
              metric: "storage_bytes",
              value: storageBytes,
            },
          ])
          .onConflictDoUpdate({
            target: [
              tenantUsageDaily.tenantId,
              tenantUsageDaily.usageDate,
              tenantUsageDaily.metric,
            ],
            set: { value: sql`excluded.value` },
          });

        // 7. Check degradation limits against today's counts (real-time enforcement)
        const degradedMetrics: string[] = [];
        if (todayApi > limits.apiCallsPerDay) degradedMetrics.push("api_calls");
        if (storageBytes > limits.storageBytes) degradedMetrics.push("storage");
        if (todayAi > limits.aiTokensPerDay) degradedMetrics.push("ai_tokens");

        // 8. Load old degraded set from Redis
        const degradedKey = `degraded:${tenantId}`;
        const oldDegraded = await redis.smembers(degradedKey);

        // 9. Update degraded set in Redis
        await redis.del(degradedKey);
        if (degradedMetrics.length > 0) {
          await redis.sadd(degradedKey, ...degradedMetrics);
        }

        // 10. Handle transitions & notify
        const newlyDegraded = degradedMetrics.filter(
          (m) => !oldDegraded.includes(m),
        );
        const newlyRecovered = oldDegraded.filter(
          (m) => !degradedMetrics.includes(m),
        );

        const adminUserIds = await listUserIdsWithRole(tenantId, "admin").catch(
          (err) => {
            logger.error(
              { err, tenantId },
              "usage-metering: failed to list tenant admins",
            );
            return [] as string[];
          },
        );

        for (const metric of newlyDegraded) {
          let value = todayApi;
          let limit = limits.apiCallsPerDay;
          if (metric === "storage") {
            value = storageBytes;
            limit = limits.storageBytes;
          } else if (metric === "ai_tokens") {
            value = todayAi;
            limit = limits.aiTokensPerDay;
          }

          logger.warn(
            { tenantId, metric, value, limit },
            "usage-metering: tenant plan limit exceeded",
          );

          for (const adminId of adminUserIds) {
            await sendNotification(
              redis,
              tenantId,
              adminId,
              "tenant.plan_degraded",
              {
                tenantId,
                metric,
                plan,
                limit,
                value,
              },
            ).catch((err: unknown) => {
              logger.error(
                { err, tenantId, adminId },
                "usage-metering: failed to send plan_degraded notification",
              );
            });
          }
        }

        for (const metric of newlyRecovered) {
          logger.info(
            { tenantId, metric },
            "usage-metering: tenant plan limit recovered",
          );

          for (const adminId of adminUserIds) {
            await sendNotification(
              redis,
              tenantId,
              adminId,
              "tenant.plan_recovered",
              {
                tenantId,
                metric,
                plan,
              },
            ).catch((err: unknown) => {
              logger.error(
                { err, tenantId, adminId },
                "usage-metering: failed to send plan_recovered notification",
              );
            });
          }
        }
      } catch (err) {
        logger.error(
          { err, tenantId },
          "usage-metering: failed to process tenant usage metering",
        );
      }
    }

    logger.info({}, "usage-metering: daily usage metering sweep complete");
  } finally {
    await redis.del(lockKey);
  }
}

export const usageMeteringWorker = new Worker(
  QUEUE_NAME,
  async () => {
    await runUsageMeteringSweep();
  },
  { connection },
);

usageMeteringWorker.on("failed", (_job, err) => {
  logger.error({ err: String(err) }, "usage-metering: worker job failed");
});

export async function scheduleUsageMetering(): Promise<void> {
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.add(
    "sweep",
    {},
    {
      repeat: { pattern: "0 2 * * *" },
      jobId: "usage-metering-recurring",
    },
  );
  await queue.close();
  logger.info({}, "usage-metering: recurring job scheduled (daily 02:00)");
}

export async function stopUsageMeteringWorker(): Promise<void> {
  await usageMeteringWorker.close();
}
