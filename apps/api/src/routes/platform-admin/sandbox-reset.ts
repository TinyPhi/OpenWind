import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import { requirePlatformAdmin } from "@platform/auth";
import {
  tenants,
  withPlatformAdminContext,
  acquireTenantAdvisoryLock,
} from "@platform/db";
import { eq } from "drizzle-orm";
import { logger } from "@platform/logger";
import {
  sandboxResetQueue,
  sandboxResetQueueEvents,
} from "../../lib/sandbox-reset-queue.js";
import { platformAdminFactory } from "./factory.js";

/**
 * T13 (docs/specs/multi-org-sandbox.md Phase 3, R7) — resets a sandbox to a clean working
 * state: wipes+reseeds module/business data, cancels queued background work, leaves the org
 * chart/accounts/credentials untouched. Keyed by tenantId directly (unlike the provisioning
 * routes, which are keyed by jobId) since this is the first platform-admin route to act on a
 * tenant the dashboard (T17) already knows the id of, rather than a job this route itself
 * created.
 *
 * Concurrency (T22, R7's third acceptance criterion): the AUTHORITATIVE sandbox-lifecycle
 * advisory lock is acquired and held by the worker itself, for the job's actual execution
 * (apps/worker/src/sandbox-reset-worker.ts), not by this route -- review finding (PR #832):
 * holding it here across `job.waitUntilFinished`'s TTL let the lock release mid-job on a
 * slow reset, defeating the point of it. This route's own acquire-check-release below is
 * only a fast pre-check, purely to return 409 quickly in the common case without
 * enqueueing a job that's certain to fail its own lock acquisition -- never relied on for
 * correctness. A race between this check and the worker's real acquisition is possible and
 * fine: the worker's own acquisition is what actually prevents two resets from running
 * concurrently against the same tenant.
 */
const TenantIdParamSchema = z.object({ tenantId: z.string().uuid() });

const WAIT_FOR_RESET_TTL_MS = 60_000;

export const sandboxResetHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  zValidator("param", TenantIdParamSchema),
  async (c) => {
    const { userId } = c.get("platformAdmin");
    const { tenantId } = c.req.valid("param");

    // R2: platform_admin_role's grant on `tenants` is column-scoped (migration 0135) to
    // exactly {id, name, isSandbox, trialEndsAt, createdAt} -- id/isSandbox is all this
    // check needs. 404, not 403, for both "no such tenant" and "not a sandbox" (security.md
    // 404-not-403 rule — a platform_admin has no narrower resource to be denied here).
    const [tenant] = await withPlatformAdminContext((tx) =>
      tx
        .select({ id: tenants.id, isSandbox: tenants.isSandbox })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    );
    if (!tenant?.isSandbox) {
      return c.json({ error: "NOT_FOUND", message: "No such sandbox" }, 404);
    }

    // Fast pre-check only -- see module doc comment. Released immediately; the worker
    // reacquires this same lock for the job's actual duration.
    const precheckLock = await acquireTenantAdvisoryLock(
      tenantId,
      "sandbox-lifecycle",
    );
    if (!precheckLock.acquired) {
      return c.json(
        {
          error: "LIFECYCLE_ACTION_IN_PROGRESS",
          message: "A reset or delete is already in progress for this sandbox",
        },
        409,
      );
    }
    try {
      await precheckLock.release();
    } catch (releaseErr) {
      logger.error(
        { tenantId, releaseErr },
        "platform-admin sandbox reset: failed to release pre-check lock",
      );
    }

    const jobId = randomUUID();
    let job;
    try {
      job = await sandboxResetQueue.add(
        "reset",
        { tenantId, requestedBy: userId },
        { jobId },
      );
    } catch (err) {
      logger.error(
        { err, tenantId, userId },
        "platform-admin sandbox reset: failed to enqueue reset job",
      );
      return c.json(
        {
          error: "ENQUEUE_FAILED",
          message: "Could not start sandbox reset — try again shortly",
        },
        503,
      );
    }

    try {
      await job.waitUntilFinished(
        sandboxResetQueueEvents,
        WAIT_FOR_RESET_TTL_MS,
      );
    } catch (err) {
      logger.error(
        { err, tenantId, userId, jobId },
        "platform-admin sandbox reset: reset job failed",
      );
      return c.json(
        {
          error: "RESET_FAILED",
          message: "Sandbox reset did not complete successfully",
        },
        500,
      );
    }

    return c.json({ data: { tenantId } }, 200);
  },
);
