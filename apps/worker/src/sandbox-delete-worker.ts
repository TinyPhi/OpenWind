/**
 * sandbox-delete-worker.ts
 *
 * T15 (docs/specs/multi-org-sandbox.md Phase 3, R8) — deletes a sandbox: removes its
 * Zitadel org (cascades to every seeded account) and initiates OpenWind-side GDPR deletion
 * immediately, rather than the real-tenant default of a 30-day delay (T14's open item (b)).
 * For each job:
 *  1. Acquire the sandbox-lifecycle advisory lock (T22) itself and hold it for the rest of
 *     this function's work, released in a finally block -- same corrected pattern T13's
 *     review fix established (PR #832): the lock's critical section must match this job's
 *     actual execution, not the API route's HTTP wait window.
 *  2. Verify the tenant still exists and is a sandbox (defensive, same convention as
 *     tenant-purge.ts's own idempotency guard).
 *  3. Delete the Zitadel org if one exists (Zitadel's v2 DeleteOrganization cascades to
 *     delete every account under it, so no per-account cleanup is needed, same call as
 *     sandbox-provisioning-worker.ts's T11 rollback). A failure here does NOT block the
 *     OpenWind-side steps below -- unlike T11's rollback (which deletes the tenant row
 *     entirely on failure), this flow never deletes the tenants row; tenant-purge.ts only
 *     ever marks it 'purged', so zitadelOrgId survives on that row as a manual-cleanup
 *     breadcrumb either way.
 *  4. Flip tenants.status to 'deleted' with deletionScheduledAt = now (immediate, not the
 *     30-day default `scheduleTenantDeletion` uses for real tenants -- apps/worker cannot
 *     import that function from apps/api, so this duplicates its minimal status-flip logic,
 *     same reasoning as every other apps/api duplication in this feature), then enqueues a
 *     delay: 0 job on the EXISTING tenant-purge queue -- reusing tenantPurgeWorker
 *     unmodified rather than duplicating its ~300 lines of purge logic.
 *  5. Audit the outcome (sandbox.delete_completed / .failed), once per job.
 */

import { eq, and, inArray } from "drizzle-orm";
import { db, tenants, acquireTenantAdvisoryLock } from "@platform/db";
import { Worker } from "@platform/telemetry";
import { logger } from "@platform/logger";
import { writeAuditEntry } from "@platform/audit";
import { deleteOrg, invalidateTenantStatusCache } from "@platform/auth";
import { connection, tenantPurgeQueue } from "./queues.js";

const QUEUE_NAME = "sandbox-delete";

type DeleteJobData = { tenantId: string; requestedBy: string };

type JobLike = { id?: string | undefined; data: DeleteJobData };

async function auditOutcome(
  job: JobLike,
  action: "sandbox.delete_completed" | "sandbox.delete_failed",
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

export async function processSandboxDeleteJob(job: JobLike): Promise<void> {
  const { tenantId } = job.data;
  logger.info({ tenantId, jobId: job.id }, "sandbox delete: starting");

  try {
    const [tenant] = await db
      .select({
        isSandbox: tenants.isSandbox,
        zitadelOrgId: tenants.zitadelOrgId,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) {
      logger.warn({ tenantId }, "sandbox delete: tenant row not found");
      throw new Error("SANDBOX_DELETE_TENANT_NOT_FOUND");
    }
    if (!tenant.isSandbox) {
      logger.warn({ tenantId }, "sandbox delete: tenant is not a sandbox");
      throw new Error("SANDBOX_DELETE_NOT_A_SANDBOX");
    }

    const lock = await acquireTenantAdvisoryLock(tenantId, "sandbox-lifecycle");
    if (!lock.acquired) {
      logger.warn(
        { tenantId },
        "sandbox delete: sandbox-lifecycle lock already held -- another lifecycle action is in progress",
      );
      throw new Error("SANDBOX_DELETE_LOCK_NOT_ACQUIRED");
    }

    let zitadelOrgDeleted: boolean | null = null;
    try {
      if (tenant.zitadelOrgId) {
        zitadelOrgDeleted = await deleteOrg(tenant.zitadelOrgId);
        if (!zitadelOrgDeleted) {
          logger.error(
            { tenantId, zitadelOrgId: tenant.zitadelOrgId },
            "sandbox delete: failed to delete Zitadel org -- proceeding with OpenWind-side deletion anyway; zitadelOrgId remains on the tenant row as a manual-cleanup breadcrumb",
          );
        }
      }

      const now = new Date();
      const [updated] = await db
        .update(tenants)
        .set({ status: "deleted", deletionScheduledAt: now, updatedAt: now })
        .where(
          and(
            eq(tenants.id, tenantId),
            inArray(tenants.status, ["active", "suspended"]),
          ),
        )
        .returning({ id: tenants.id });

      if (!updated) {
        logger.warn(
          { tenantId },
          "sandbox delete: tenant was not in active/suspended status -- already deleted or in an unexpected state",
        );
        throw new Error("SANDBOX_DELETE_INVALID_TENANT_STATUS");
      }

      invalidateTenantStatusCache(tenantId);

      await tenantPurgeQueue.add(
        "purge",
        { tenantId },
        {
          delay: 0,
          jobId: `tenant-purge-${tenantId}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 60_000 },
          removeOnComplete: { age: 7 * 24 * 3600 },
          removeOnFail: false,
        },
      );
      logger.info({ tenantId }, "sandbox delete: immediate purge enqueued");
    } finally {
      try {
        await lock.release();
      } catch (releaseErr) {
        logger.error(
          { tenantId, releaseErr },
          "sandbox delete: failed to release sandbox-lifecycle lock",
        );
      }
    }

    await auditOutcome(job, "sandbox.delete_completed", {
      zitadelOrgId: tenant.zitadelOrgId ?? null,
      zitadelOrgDeleted,
    });
    logger.info({ tenantId }, "sandbox delete: complete");
  } catch (err) {
    const message = err instanceof Error ? err.message : "UNKNOWN";
    await auditOutcome(job, "sandbox.delete_failed", { error: message }).catch(
      (auditErr: unknown) => {
        logger.error(
          { err: auditErr, tenantId, jobId: job.id },
          "sandbox delete: failed to audit failure",
        );
      },
    );
    throw err;
  }
}

export const sandboxDeleteWorker = new Worker<DeleteJobData, void>(
  QUEUE_NAME,
  (job) => processSandboxDeleteJob(job),
  {
    connection,
    concurrency: 1,
    removeOnComplete: { age: 3_600 },
    removeOnFail: { age: 604_800 },
  },
);

export function stopSandboxDeleteWorker(): Promise<void> {
  return sandboxDeleteWorker.close();
}
