/**
 * sandbox-reset-worker.ts
 *
 * T13 (docs/specs/multi-org-sandbox.md Phase 3, R7) — resets a sandbox tenant to a clean
 * working state without disturbing its identity. For each job:
 *  1. Verify the tenant still exists and is a sandbox (defensive, same convention as
 *     tenant-purge.ts's own idempotency guard -- the real check already happened in the API
 *     route before this job was enqueued).
 *  1b. Acquire the sandbox-lifecycle advisory lock (T22) and hold it for the rest of this
 *      function's work, released in a finally block. Review finding (PR #832): the lock
 *      was previously acquired and held by the API route across its
 *      `job.waitUntilFinished` call, tied to that call's TTL -- a reset that outran the
 *      TTL released the lock while the job kept running, letting a second concurrent
 *      request enqueue a second reset against the same tenant. The lock's critical
 *      section must match the job's actual execution, not the HTTP route's wait window,
 *      so the worker (which actually performs the wipe) now owns it. The route still does
 *      its own quick acquire-check-release before enqueueing, purely to return 409 fast in
 *      the common case -- the lock acquired here is what's actually authoritative.
 *  2. Cancel queued-but-not-yet-processed jobs for this tenant in the queues that could
 *     otherwise fire after reset and reference wiped data: automation follow-ups, SLA
 *     breach timers, and due-date reminders. Only waiting/delayed jobs are removed -- a job
 *     already active keeps running (it already has whatever data it needs in memory; racing
 *     to cancel it would risk a half-applied side effect, which is worse than letting one
 *     stale notification through).
 *  3. Wipe only business/module data for this tenant (R7: "tickets, workflow instances,
 *     automation-execution history") -- entity_types/workflows/workflow_states/
 *     workflow_transitions/automation_rules (module CONFIG, reinstalled identically by T9's
 *     installCoreModulesForSandbox) and every org/account-identity table (teams, services,
 *     on_call_schedules, notification_policies, tenant_users, api_keys,
 *     connector_credentials, installed_plugins, org_employees, schedule_rules, tenants
 *     itself) are deliberately NOT in RESET_TENANT_TABLES -- reset returns the sandbox to a
 *     clean DEMO state, not a freshly-provisioned one; a prospect's org chart, accounts, and
 *     admin-configured scheduler/on-call setup are not "business data" R7 asks to wipe.
 *  4. Re-seed module data via seedAllModulesData against the tenant's already-installed
 *     modules (tenants.config.installed_modules, written by installCoreModulesForSandbox at
 *     provisioning time) -- NOT a full module reinstall, since step 3 never touched
 *     entity_types/workflows/automation_rules.
 *  5. Audit the outcome (sandbox.reset_completed / .failed), once per job, same convention
 *     as sandbox-provisioning-worker.ts's auditOutcome.
 */

import { eq } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  acquireTenantAdvisoryLock,
} from "@platform/db";
import {
  entityInstances,
  entityRelations,
  workflowEvents,
  automationExecutions,
  outboxEvents,
  deadLetterEvents,
  connectorDeliveryAttempts,
  idempotencyKeys,
  ticketAlerts,
  accessRequests,
  attachments,
  files,
  notifications,
  notificationRecipients,
  savedViews,
  labels,
  ticketLabels,
  entityInstanceTags,
  scheduleExecutions,
} from "@platform/db";
import { Worker } from "@platform/telemetry";
import { logger } from "@platform/logger";
import { writeAuditEntry } from "@platform/audit";
import { deleteTenantFiles } from "@platform/files";
import {
  automationQueue,
  slaQueue,
  dueDateQueue,
  dueDateApproachingQueue,
  connection,
} from "./queues.js";
import { seedAllModulesData } from "./sandbox-module-data-seed.js";

/**
 * Every table a reset deletes from (SQL names) -- business/module data only. Deliberately
 * narrower than tenant-purge.ts's PURGED_TENANT_TABLES: a reset is not an erasure, so this
 * list is NOT subject to the erasure-table-coverage-guard (that guard only requires every
 * tenant-scoped table appear in PURGED_TENANT_TABLES or ERASURE_EXEMPT_TABLES, which is
 * still true for every one of these -- reset is an additional, narrower operation on top).
 */
export const RESET_TENANT_TABLES: readonly string[] = [
  "notification_recipients",
  "notifications",
  "ticket_labels",
  "labels",
  "entity_instance_tags",
  "ticket_alerts",
  "access_requests",
  "attachments",
  "files",
  "workflow_events",
  "entity_relations",
  "entity_instances",
  "automation_executions",
  "dead_letter_events",
  "outbox_events",
  "connector_delivery_attempts",
  "saved_views",
  "schedule_executions",
  "idempotency_keys",
];

const QUEUE_NAME = "sandbox-reset";

type ResetJobData = { tenantId: string; requestedBy: string };

type JobLike = { id?: string | undefined; data: ResetJobData };

/**
 * Removes queued (waiting/delayed) jobs for this tenant from the queues that could
 * otherwise fire after reset and reference data this job is about to wipe. BullMQ has no
 * built-in "remove by tenantId" -- each queue's own jobs are inspected and filtered by
 * `job.data.tenantId`. Active jobs are left alone (see module doc comment).
 *
 * Deliberately scoped to automation/SLA/due-date queues only (review finding, PR #832) --
 * notification and outbox-delivery queues are NOT scanned here. A queued notification job
 * referencing a row this reset is about to wipe simply fails gracefully (row not found) and
 * logs an error; that's acceptable noise for an infrequent admin action, and R7 only names
 * "scheduled notifications, automation follow-ups" (the delayed/recurring kind these four
 * queues hold), not immediate dispatch jobs.
 */
async function cancelQueuedJobsForTenant(tenantId: string): Promise<number> {
  const queues = [
    automationQueue,
    slaQueue,
    dueDateQueue,
    dueDateApproachingQueue,
  ];
  let cancelled = 0;

  for (const queue of queues) {
    const jobs = await queue.getJobs(["waiting", "delayed"]);
    for (const job of jobs) {
      if ((job.data as { tenantId?: string }).tenantId !== tenantId) continue;
      try {
        await job.remove();
        cancelled++;
      } catch (err) {
        logger.error(
          { err, tenantId, queueName: queue.name, jobId: job.id },
          "sandbox reset: failed to cancel a queued job -- continuing",
        );
      }
    }
  }

  return cancelled;
}

async function auditOutcome(
  job: JobLike,
  action: "sandbox.reset_completed" | "sandbox.reset_failed",
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeAuditEntry(db, {
    tenantId: job.data.tenantId,
    actorId: job.data.requestedBy,
    actorType: "user",
    resourceType: "tenant",
    resourceId: job.data.tenantId,
    action,
    metadata: { jobId: job.id, ...metadata },
  });
}

export async function processSandboxResetJob(job: JobLike): Promise<void> {
  const { tenantId } = job.data;
  logger.info({ tenantId, jobId: job.id }, "sandbox reset: starting");

  try {
    const [tenant] = await db
      .select({ isSandbox: tenants.isSandbox, config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) {
      logger.warn({ tenantId }, "sandbox reset: tenant row not found");
      throw new Error("SANDBOX_RESET_TENANT_NOT_FOUND");
    }
    if (!tenant.isSandbox) {
      logger.warn({ tenantId }, "sandbox reset: tenant is not a sandbox");
      throw new Error("SANDBOX_RESET_NOT_A_SANDBOX");
    }

    const lock = await acquireTenantAdvisoryLock(tenantId, "sandbox-lifecycle");
    if (!lock.acquired) {
      logger.warn(
        { tenantId },
        "sandbox reset: sandbox-lifecycle lock already held -- another lifecycle action is in progress",
      );
      throw new Error("SANDBOX_RESET_LOCK_NOT_ACQUIRED");
    }

    let cancelledJobCount: number;
    try {
      cancelledJobCount = await cancelQueuedJobsForTenant(tenantId);
      logger.info(
        { tenantId, cancelledJobCount },
        "sandbox reset: jobs cancelled",
      );

      // Privileged pre-step, same reasoning as tenant-purge.ts: schedule_executions is
      // append-only (INSERT+SELECT grant) and saved_views' RLS policy requires
      // user_id = app.user_id, which a tenant-wide reset has no single value for. Both are
      // deleted on the worker's privileged `db` connection with an explicit tenant_id filter.
      await db
        .delete(scheduleExecutions)
        .where(eq(scheduleExecutions.tenantId, tenantId));
      await db.delete(savedViews).where(eq(savedViews.tenantId, tenantId));

      await withTenantContext(tenantId, async (tx) => {
        await tx
          .delete(notificationRecipients)
          .where(eq(notificationRecipients.tenantId, tenantId));
        await tx
          .delete(notifications)
          .where(eq(notifications.tenantId, tenantId));

        await tx
          .delete(ticketLabels)
          .where(eq(ticketLabels.tenantId, tenantId));
        await tx.delete(labels).where(eq(labels.tenantId, tenantId));
        await tx
          .delete(entityInstanceTags)
          .where(eq(entityInstanceTags.tenantId, tenantId));
        await tx
          .delete(ticketAlerts)
          .where(eq(ticketAlerts.tenantId, tenantId));
        await tx
          .delete(accessRequests)
          .where(eq(accessRequests.tenantId, tenantId));

        // attachments → files is NO ACTION, so attachments go first
        await tx.delete(attachments).where(eq(attachments.tenantId, tenantId));
        await tx.delete(files).where(eq(files.tenantId, tenantId));

        // workflow_events / entity_relations are FK children of entity_instances
        await tx
          .delete(workflowEvents)
          .where(eq(workflowEvents.tenantId, tenantId));
        await tx
          .delete(entityRelations)
          .where(eq(entityRelations.tenantId, tenantId));
        await tx
          .delete(entityInstances)
          .where(eq(entityInstances.tenantId, tenantId));

        await tx
          .delete(automationExecutions)
          .where(eq(automationExecutions.tenantId, tenantId));

        await tx
          .delete(deadLetterEvents)
          .where(eq(deadLetterEvents.tenantId, tenantId));
        await tx
          .delete(outboxEvents)
          .where(eq(outboxEvents.tenantId, tenantId));
        await tx
          .delete(connectorDeliveryAttempts)
          .where(eq(connectorDeliveryAttempts.tenantId, tenantId));

        await tx
          .delete(idempotencyKeys)
          .where(eq(idempotencyKeys.tenantId, tenantId));
      });
      logger.info({ tenantId }, "sandbox reset: business data wiped");

      const config = (tenant.config ?? {}) as Record<string, unknown>;
      const installedModules = Array.isArray(config["installed_modules"])
        ? (config["installed_modules"] as string[])
        : [];
      await seedAllModulesData(tenantId, installedModules);
      logger.info(
        { tenantId, installedModules },
        "sandbox reset: module data reseeded",
      );

      // Best-effort, outside the DB transaction -- same convention as tenant-purge.ts's
      // deleteTenantFiles call.
      await deleteTenantFiles(tenantId);
    } finally {
      // Swallow a release failure rather than letting it mask the real result/error above --
      // same reasoning as packages/org-directory/src/sync.ts's identical pattern.
      try {
        await lock.release();
      } catch (releaseErr) {
        logger.error(
          { tenantId, releaseErr },
          "sandbox reset: failed to release sandbox-lifecycle lock",
        );
      }
    }

    await auditOutcome(job, "sandbox.reset_completed", { cancelledJobCount });
    logger.info({ tenantId }, "sandbox reset: complete");
  } catch (err) {
    const message = err instanceof Error ? err.message : "UNKNOWN";
    await auditOutcome(job, "sandbox.reset_failed", { error: message }).catch(
      (auditErr: unknown) => {
        logger.error(
          { err: auditErr, tenantId, jobId: job.id },
          "sandbox reset: failed to audit failure",
        );
      },
    );
    throw err;
  }
}

export const sandboxResetWorker = new Worker<ResetJobData, void>(
  QUEUE_NAME,
  (job) => processSandboxResetJob(job),
  {
    connection,
    concurrency: 1,
    removeOnComplete: { age: 3_600 },
    removeOnFail: { age: 604_800 },
  },
);

export function stopSandboxResetWorker(): Promise<void> {
  return sandboxResetWorker.close();
}
