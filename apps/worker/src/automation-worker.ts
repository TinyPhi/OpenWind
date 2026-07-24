import { Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { withTenantContext, deadLetterEvents } from "@platform/db";
import {
  executeAutomationRules,
  OutboxDepthSchema,
} from "@platform/automation-engine";
import { env } from "@platform/config";
import { logger } from "@platform/logger";

// maxRetriesPerRequest must be null for BullMQ worker connections;
// without it a transient Redis blip throws MaxRetriesPerRequestError and drops jobs.
// Exported (not just local) so health-server.ts can include this connection's
// status in /healthz — it's independent from queues.ts's shared connection,
// and automation processing is the worker's most Redis-dependent path (#129).
export const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

interface AutomationJobData {
  outboxEventId: string;
  tenantId: string;
  eventType: string;
  version: number;
  payload: unknown;
  ruleId?: string;
}

// Recovers the recursion depth carried in the outbox payload (#120) — without
// this, every outbox-routed automation chain would resume at depth 0 no
// matter how deep the in-process chain that produced it already was, and
// MAX_DEPTH would never bound a cycle that loops purely through the outbox.
// Uses OutboxDepthSchema (packages/automation-engine/src/event-schemas.ts) so
// the int/non-negative constraint lives in one place, not re-declared here —
// a malformed or malicious depth value must not defeat the MAX_DEPTH guard.
function readDepth(payload: unknown): number {
  return OutboxDepthSchema.safeParse(payload).data?.depth ?? 0;
}

export const automationWorker = new Worker<AutomationJobData>(
  "automation",
  async (job) => {
    const { tenantId, payload } = job.data;
    // Resume MAX_DEPTH counting from the depth this event was triggered at
    // (stamped by the transition action) instead of resetting to 0 — an
    // outbox-delivered event from a recursive automation loop must still be
    // bounded. Events from direct user/API transitions carry no depth and
    // start at 0. See issue #120.
    // Pass the Redis connection so the circuit breaker is active.
    // Without this argument the circuit breaker guard is silently skipped.
    await withTenantContext(tenantId, (tx) =>
      executeAutomationRules(
        tx,
        tenantId,
        payload,
        readDepth(payload),
        connection,
      ),
    );
  },
  { connection, concurrency: 5 },
);

async function handleFailedJob(
  job: Job<AutomationJobData> | undefined,
  err: Error,
): Promise<void> {
  if (!job || (job.opts.attempts ?? 1) > job.attemptsMade) return;

  const { outboxEventId, tenantId, eventType, payload, ruleId } =
    job.data as AutomationJobData;

  try {
    // Use withTenantContext so the insert runs with tenant_id set consistently
    // with all other writes — defensive against any future RLS reinstatement.
    await withTenantContext(tenantId, (tx) =>
      tx.insert(deadLetterEvents).values({
        tenantId,
        originalEventId: outboxEventId,
        eventType,
        payload: payload as Record<string, unknown>,
        ruleId: ruleId ?? null,
        error: err.message,
        attemptCount: job.attemptsMade,
      }),
    );
    logger.warn(
      { tenantId, outboxEventId, eventType },
      "Automation: job moved to dead letter queue",
    );
  } catch (dlqErr) {
    logger.error(
      { tenantId, outboxEventId, dlqErr },
      "Automation: failed to write to dead letter queue",
    );
  }
}

automationWorker.on("failed", (job, err) => {
  void handleFailedJob(job, err);
});

export function stopAutomationWorker(): Promise<void> {
  return automationWorker.close();
}
