/**
 * SLA Breacher — BullMQ worker that fires when a delayed SLA job becomes due.
 *
 * Guard: before writing the breach event it checks that the entity instance is
 * still in the expected state.  If the instance has already transitioned away,
 * the job is a no-op.  This handles the race where the transition and the job
 * fire concurrently — the engine's cancelPendingSlaTimers only covers jobs that
 * haven't been enqueued yet.
 *
 * Atomicity (G1): the state guard SELECT and the outbox INSERT are wrapped in a
 * single transaction.  Without this, a concurrent executeTransition committing
 * between the guard read and the INSERT would pass the guard check but write a
 * breach event for a state the instance had already left (TOCTOU).
 *
 * Retries (G2): the slaQueue is created with defaultJobOptions.attempts=3 and
 * exponential backoff.  On final exhaustion the "failed" event handler writes
 * to dead_letter_events so operators can inspect and re-trigger rather than
 * silently losing the breach.
 */

import { Worker } from "bullmq";
import { eq, and } from "drizzle-orm";
import {
  withTenantContext,
  outboxEvents,
  entityInstances,
  deadLetterEvents,
} from "@platform/db";
import { logger } from "@platform/logger";
import { connection } from "./queues.js";
import type { SlaJobData } from "./sla-scheduler.js";
import type { WorkflowSlaBreachedEvent } from "@platform/workflow-engine";
import { validateActiveTenant } from "./tenant-guard.js";

/**
 * Jobs that fire more than 15 minutes past their scheduled fireAt are logged
 * as warnings.  This surfaces BullMQ downtime recoveries without blocking the
 * breach event — the event is still written, but operators are alerted.
 */
const LATE_WARNING_THRESHOLD_MS = 15 * 60 * 1000;

export const slaBreacher = new Worker<SlaJobData>(
  "sla",
  async (job) => {
    const {
      outboxEventId,
      tenantId,
      instanceId,
      workflowId,
      stateName,
      slaHours,
    } = job.data;

    const active = await validateActiveTenant(tenantId, "SLA breach check", {
      instanceId,
      stateName,
      outboxEventId,
      jobId: job.id,
    });
    if (!active) return;

    // Warn if the job fired significantly later than its scheduled fireAt.
    // This happens when BullMQ was down and the job was delayed on recovery.
    const scheduledFireAt = new Date(job.data.fireAt).getTime();
    const latencyMs = Date.now() - scheduledFireAt;
    if (latencyMs > LATE_WARNING_THRESHOLD_MS) {
      logger.warn(
        { tenantId, instanceId, stateName, latencyMs, outboxEventId },
        "SLA breach: job fired significantly late — possible BullMQ downtime recovery",
      );
    }

    // G1: wrap the guard SELECT and the outbox INSERT in a single transaction
    // so no concurrent executeTransition can slip through the TOCTOU window.
    // withTenantContext issues SET LOCAL ROLE app_user + sets app.tenant_id
    // so RLS second layer is enforced on outbox_events and entityInstances.
    await withTenantContext(tenantId, async (tx) => {
      // Guard: is the instance still in the SLA-tracked state?
      const [instance] = await tx
        .select({
          currentState: entityInstances.currentState,
          entityTypeId: entityInstances.entityTypeId,
        })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.id, instanceId),
            eq(entityInstances.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!instance) {
        logger.info(
          { tenantId, instanceId, stateName, outboxEventId },
          "SLA breach: instance not found — skipping",
        );
        return;
      }

      if (instance.currentState !== stateName) {
        logger.info(
          {
            tenantId,
            instanceId,
            stateName,
            currentState: instance.currentState,
            outboxEventId,
          },
          "SLA breach: instance already transitioned — skipping",
        );
        return;
      }

      // Write the breach event to the outbox.  Field names match
      // WorkflowSlaBreachedV1Schema so TriggerEventSchema.safeParse succeeds
      // in the outbox poller without transformation.
      const breachPayload: WorkflowSlaBreachedEvent = {
        eventType: "workflow.sla_breached",
        version: 1,
        tenantId,
        instanceId,
        entityTypeId: instance.entityTypeId,
        workflowId,
        state: stateName,
        slaHours,
        breachedAt: new Date().toISOString(),
      };

      await tx.insert(outboxEvents).values({
        tenantId,
        eventType: "workflow.sla_breached",
        version: 1,
        payload: breachPayload,
      });

      logger.info(
        { tenantId, instanceId, stateName, slaHours, outboxEventId },
        "SLA breach: outbox event written",
      );
    });
  },
  { connection },
);

slaBreacher.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, data: job?.data, err },
    "SLA breach job failed",
  );

  // G2: on final exhaustion write to dead_letter_events so the breach is not
  // silently lost.  Transient failures that succeed on a later attempt do not
  // reach this branch because BullMQ only emits "failed" after all attempts.
  if (!job) return;
  const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (exhausted) {
    const {
      tenantId,
      instanceId,
      workflowId,
      stateName,
      slaHours,
      outboxEventId,
    } = job.data;
    // withTenantContext issues SET LOCAL ROLE app_user + app.tenant_id GUC
    // so dead_letter_events RLS WITH CHECK passes without manual set_config.
    void withTenantContext(tenantId, async (tx) => {
      await tx.insert(deadLetterEvents).values({
        tenantId,
        originalEventId: outboxEventId,
        eventType: "workflow.sla_breached",
        payload: {
          instanceId,
          workflowId,
          stateName,
          slaHours,
        } as Record<string, unknown>,
        ruleId: null,
        error: err.message,
        attemptCount: job.attemptsMade,
      });
    }).catch((dlqErr: unknown) => {
      logger.error(
        { jobId: job.id, dlqErr },
        "SLA breach: failed to write dead-letter event",
      );
    });
  }
});
