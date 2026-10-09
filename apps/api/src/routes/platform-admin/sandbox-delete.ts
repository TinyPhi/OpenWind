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
  sandboxDeleteQueue,
  sandboxDeleteQueueEvents,
} from "../../lib/sandbox-delete-queue.js";
import { platformAdminFactory } from "./factory.js";

/**
 * T15 (docs/specs/multi-org-sandbox.md Phase 3, R8) — deletes a sandbox: removes its
 * Zitadel org (cascades to every seeded account) and initiates immediate OpenWind-side
 * deletion (not the real-tenant 30-day default delay -- T14's open item (b)). A 200
 * response means the Zitadel org is gone and the tenant is locked out + queued for purge,
 * not that the full DB purge has finished -- that proceeds via the existing, unmodified
 * tenant-purge worker, same as real-tenant deletion already works. Keyed by tenantId
 * directly, same convention as sandbox-reset.ts.
 *
 * Concurrency (T22): same corrected pattern as sandbox-reset.ts (review finding, PR #832)
 * -- the AUTHORITATIVE sandbox-lifecycle advisory lock is acquired and held by the worker
 * itself (apps/worker/src/sandbox-delete-worker.ts) for the job's actual execution. This
 * route's own acquire-check-release below is only a fast pre-check for a quick 409 in the
 * common case, never relied on for correctness.
 */
const TenantIdParamSchema = z.object({ tenantId: z.string().uuid() });

const WAIT_FOR_DELETE_TTL_MS = 60_000;

export const sandboxDeleteHandler = platformAdminFactory.createHandlers(
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
        "platform-admin sandbox delete: failed to release pre-check lock",
      );
    }

    const jobId = randomUUID();
    let job;
    try {
      job = await sandboxDeleteQueue.add(
        "delete",
        { tenantId, requestedBy: userId },
        { jobId },
      );
    } catch (err) {
      logger.error(
        { err, tenantId, userId },
        "platform-admin sandbox delete: failed to enqueue delete job",
      );
      return c.json(
        {
          error: "ENQUEUE_FAILED",
          message: "Could not start sandbox deletion — try again shortly",
        },
        503,
      );
    }

    try {
      await job.waitUntilFinished(
        sandboxDeleteQueueEvents,
        WAIT_FOR_DELETE_TTL_MS,
      );
    } catch (err) {
      logger.error(
        { err, tenantId, userId, jobId },
        "platform-admin sandbox delete: delete job failed",
      );
      return c.json(
        {
          error: "DELETE_FAILED",
          message: "Sandbox deletion did not complete successfully",
        },
        500,
      );
    }

    return c.json({ data: { tenantId } }, 200);
  },
);
