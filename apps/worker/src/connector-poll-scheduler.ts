/**
 * connector-poll-scheduler.ts
 *
 * Reconcile-tick scheduler for polling-type connector installations (ADR-009
 * Decision #7, issue #366). There is no install/uninstall API route yet
 * (that's #369's scope) and no explicit register/unregister call site, so
 * this ticker is the ONLY place a `connector-poll` BullMQ repeatable job is
 * created or removed: every tick it lists every `connector_credentials` row
 * across all tenants, resolves each installation's connector definition from
 * the in-process registry, and diffs the resulting desired set against
 * BullMQ's live `getRepeatableJobs()` — adding jobs for new installations,
 * removing them for uninstalled/deregistered ones, and replacing them when a
 * connector's `intervalMinutes` changes between deploys.
 *
 * Mirrors sla-scheduler.ts's shape (setInterval ticker over a table, guarded
 * against overlapping ticks) rather than relying on BullMQ's own `repeat`
 * option being set once at install time, since there is nothing to call at
 * install time yet.
 */

import { isNull } from "drizzle-orm";
import { connectorPollQueue } from "./queues.js";
import { db, connectorCredentials } from "@platform/db";
import { getConnectorDefinition } from "@platform/connector-sdk";
import { logger } from "@platform/logger";

const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

// Floor on a connector's declared polling interval — a definition shipping
// `intervalMinutes: 0` (or negative) would otherwise pass straight into
// BullMQ's `repeat.every`, producing a job that re-fires continuously
// (hammering the connector's third-party host and this worker's own
// DB/Redis). 1 minute is deliberately conservative for v1 (email/WhatsApp,
// ADR-009's "Product decision: v1 connector set") — no registered connector
// today needs anything near this floor.
const MIN_INTERVAL_MINUTES = 1;

export function pollJobId(tenantId: string, connectorId: string): string {
  return `connector-poll:${tenantId}:${connectorId}`;
}

interface DesiredPollJob {
  tenantId: string;
  connectorId: string;
  everyMs: number;
}

async function buildDesiredJobs(): Promise<Map<string, DesiredPollJob>> {
  // Kill switch (issue #367) — filtered in SQL, not after the fact in JS:
  // a disabled installation's row never crosses the wire into this process,
  // and is excluded from the desired set entirely rather than merely
  // skipped at execution time — no repeatable job is scheduled for it.
  const installations = await db
    .select({
      tenantId: connectorCredentials.tenantId,
      connectorId: connectorCredentials.connectorId,
    })
    .from(connectorCredentials)
    .where(isNull(connectorCredentials.disabledAt));

  const desired = new Map<string, DesiredPollJob>();

  for (const row of installations) {
    const definition = getConnectorDefinition(row.connectorId);
    if (!definition) {
      // Expected/benign until #368 ships the first registered connectors.
      continue;
    }
    const trigger = definition.triggers.find((t) => t.type === "polling");
    if (!trigger?.polling) continue;

    const { intervalMinutes } = trigger.polling;
    if (
      !Number.isFinite(intervalMinutes) ||
      intervalMinutes < MIN_INTERVAL_MINUTES
    ) {
      logger.error(
        { connectorId: row.connectorId, intervalMinutes },
        "connector-poll-scheduler: connector declared an invalid intervalMinutes — skipping installation",
      );
      continue;
    }

    desired.set(pollJobId(row.tenantId, row.connectorId), {
      tenantId: row.tenantId,
      connectorId: row.connectorId,
      everyMs: intervalMinutes * 60_000,
    });
  }

  return desired;
}

export async function reconcile(): Promise<void> {
  try {
    const desired = await buildDesiredJobs();
    const existing = await connectorPollQueue.getRepeatableJobs();

    // BullMQ's getRepeatableJobs() never returns an `id` field for jobs
    // stored via the normal add({repeat}) path (only `key`, `name`, `every`,
    // etc. — see bullmq's Repeat.getRepeatableData()). Matching therefore has
    // to go through `key`, which is why every add() below passes an explicit
    // `repeat.key` (BullMQ: "Custom repeatable key ... for easier retrieval")
    // set to pollJobId(...) instead of letting BullMQ hash-derive an opaque
    // one — that makes `job.key` here exactly equal to this reconcile's own
    // desired-map key, with no decoding step.
    const alreadyCorrect = new Set<string>();
    for (const job of existing) {
      const wanted = desired.get(job.key);
      // `every` round-trips through Redis as a string — compare numerically.
      if (wanted?.everyMs === Number(job.every)) {
        alreadyCorrect.add(job.key);
      } else {
        await connectorPollQueue.removeRepeatableByKey(job.key);
      }
    }

    for (const [jobId, target] of desired) {
      // Skip an already-correct job: BullMQ's addRepeatableJob script
      // unconditionally cancels and re-derives the pending delayed job's
      // next-fire time from "now" on every add() call, even when `repeat.key`
      // and `every` are unchanged (confirmed against bullmq 5.76.8's
      // addRepeatableJob-2.lua — "If we are overriding a repeatable job we
      // must delete the delayed job for the next iteration"). Calling add()
      // on every reconcile tick would keep resetting the schedule before it
      // ever reaches its due time whenever intervalMinutes >= the reconcile
      // interval — the same "never fires" failure the key-matching fix above
      // addresses, via a different code path.
      if (alreadyCorrect.has(jobId)) continue;
      await connectorPollQueue.add(
        "connector.poll",
        { tenantId: target.tenantId, connectorId: target.connectorId },
        { repeat: { key: jobId, every: target.everyMs } },
      );
    }

    logger.info(
      { desiredCount: desired.size },
      "connector-poll-scheduler: reconcile tick complete",
    );
  } catch (err) {
    logger.error({ err }, "connector-poll-scheduler: reconcile tick failed");
  }
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;

export function startConnectorPollScheduler(
  intervalMs = DEFAULT_RECONCILE_INTERVAL_MS,
): void {
  if (tickTimer) return;

  activeTick = reconcile().finally(() => {
    activeTick = null;
  });

  tickTimer = setInterval(() => {
    if (activeTick) return;
    activeTick = reconcile().finally(() => {
      activeTick = null;
    });
  }, intervalMs);

  logger.info({ intervalMs }, "connector-poll-scheduler started");
}

export async function stopConnectorPollScheduler(): Promise<void> {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (activeTick) {
    await activeTick;
    activeTick = null;
  }
  logger.info({}, "connector-poll-scheduler stopped");
}
