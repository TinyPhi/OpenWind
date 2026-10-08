import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import {
  requirePlatformAdmin,
  getSandboxHandoverCredentials,
} from "@platform/auth";
import {
  db,
  sandboxProvisioningJobs,
  withPlatformAdminContext,
  checkSandboxQuota,
  toProvisioningProgressView,
} from "@platform/db";
import { eq } from "drizzle-orm";
import { env } from "@platform/config";
import { sandboxProvisioningQueue } from "../../lib/sandbox-provisioning-queue.js";
import { enforceSandboxProvisioningRateLimit } from "../../lib/rate-limit-tiers.js";
import { logger } from "@platform/logger";
import { platformAdminFactory } from "./factory.js";

/**
 * T7 (docs/specs/multi-org-sandbox.md Phase 2) — starts a sandbox provisioning job.
 * Returns only a job id; T8's progress-polling route and T21's handover route (both below)
 * read back the row this route inserts. The quota check reads `tenants` under
 * `platform_admin_role` (column-scoped SELECT, R2) — it only counts rows, it does not
 * reserve a slot (packages/db/src/platform-admin-view.ts's own doc comment), so two
 * concurrent requests from the same platform_admin can still race past the limit by a
 * small margin. Acceptable for a single-trusted-operator v1 (§C) and no worse than the
 * pre-existing behaviour this route introduces.
 *
 * Security review (PR2): the generic global rate limit (500/min/IP, apps/api/src/app.ts) is
 * sized for ordinary CRUD, not for a route whose happy path drives ~21+ outbound Zitadel
 * calls per request -- enforceSandboxProvisioningRateLimit adds a tight, per-platform_admin
 * override (default 3/min, RATE_LIMIT_SANDBOX_PROVISIONING_PER_MIN) checked before the quota
 * read, so a runaway/compromised platform_admin session can't turn each accepted request into
 * dozens of Zitadel calls faster than this.
 */
const CreateSandboxSchema = z.object({
  orgName: z.string().min(1).max(255),
  trialDays: z.number().int().positive().max(365).default(14),
});

export const createSandboxHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  zValidator("json", CreateSandboxSchema),
  async (c) => {
    const { userId } = c.get("platformAdmin");
    const { orgName, trialDays } = c.req.valid("json");

    const rateLimit = await enforceSandboxProvisioningRateLimit(userId);
    if (!rateLimit.allowed) {
      return c.json(
        {
          error: "RATE_LIMITED",
          message: "Too many sandbox provisioning requests — slow down",
        },
        429,
      );
    }

    const quota = await withPlatformAdminContext((tx) =>
      checkSandboxQuota(tx, userId, env.PLATFORM_ADMIN_MAX_ACTIVE_SANDBOXES),
    );
    if (!quota.allowed) {
      return c.json(
        {
          error: "SANDBOX_QUOTA_EXCEEDED",
          message: `Active sandbox limit reached (${quota.current}/${quota.limit})`,
        },
        409,
      );
    }

    // Inserted via plain `db`, not withPlatformAdminContext -- platform_admin_role has only
    // SELECT on this table (migration 0137); writes are apps/api's own bookkeeping, same
    // reasoning as the worker inserting the `tenants` row via plain `db` in
    // sandbox-provisioning-worker.ts. The id is generated here (not DB-defaulted) so it can
    // be passed to BullMQ as the job's own id, giving the progress/handover routes below a
    // single id to look up regardless of whether the job has started yet.
    const jobId = randomUUID();
    await db.insert(sandboxProvisioningJobs).values({
      id: jobId,
      requestedBy: userId,
      orgName,
      status: "pending",
    });

    // Review finding (PR #804/#805): an unhandled queue.add() throw (Redis/BullMQ down)
    // would otherwise leave the row above stuck at "pending" forever -- no worker would ever
    // pick it up, so the progress endpoint would report "pending" indefinitely with no signal
    // anything is wrong. Deleting the row on failure means a retried request starts clean
    // rather than accumulating orphaned rows, and the caller gets an actionable 503 instead
    // of a stuck job id.
    try {
      await sandboxProvisioningQueue.add(
        "provision",
        { orgName, trialDays, requestedBy: userId },
        { jobId },
      );
    } catch (err) {
      await db
        .delete(sandboxProvisioningJobs)
        .where(eq(sandboxProvisioningJobs.id, jobId));
      logger.error(
        { err, userId, jobId },
        "platform-admin sandboxes: failed to enqueue provisioning job",
      );
      return c.json(
        {
          error: "ENQUEUE_FAILED",
          message: "Could not start sandbox provisioning — try again shortly",
        },
        503,
      );
    }

    return c.json({ data: { jobId } }, 202);
  },
);

/**
 * T8 (R5) — polled by the wait-screen instead of holding one HTTP connection open for the
 * full provisioning duration. Returns 404 for an unknown job id (security.md's
 * 404-not-403 rule — a platform_admin has no narrower resource to be denied access to
 * here, there's only "exists" or "doesn't").
 */
const JobIdParamSchema = z.object({ jobId: z.string().uuid() });

export const sandboxProgressHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  zValidator("param", JobIdParamSchema),
  async (c) => {
    const { jobId } = c.req.valid("param");
    const row = await withPlatformAdminContext((tx) =>
      tx
        .select({
          id: sandboxProvisioningJobs.id,
          status: sandboxProvisioningJobs.status,
          currentStep: sandboxProvisioningJobs.currentStep,
          completedSteps: sandboxProvisioningJobs.completedSteps,
          totalSteps: sandboxProvisioningJobs.totalSteps,
          error: sandboxProvisioningJobs.error,
        })
        .from(sandboxProvisioningJobs)
        .where(eq(sandboxProvisioningJobs.id, jobId))
        .limit(1),
    );
    const job = row[0];
    if (!job) {
      return c.json(
        { error: "NOT_FOUND", message: "No such provisioning job" },
        404,
      );
    }
    return c.json({ data: toProvisioningProgressView(job) });
  },
);

/**
 * T21 (R5) — the actual handover artifact: seeded usernames + the shared password used, for
 * handing off to the prospect. 404 if no completed job exists for this tenant, or if the
 * credentials have since expired (security review: the handover artifact lives in Redis
 * with a 7-day TTL, packages/auth/src/sandbox-handover-store.ts, not a durable DB column —
 * see migration 0137's comment for why). 409 if the job exists but hasn't completed yet (an
 * existence leak would be the wrong classification here since platform_admin is the one who
 * created the tenant in the first place).
 *
 * Review finding (PR #805): this does NOT filter by `requestedBy` -- any platform_admin can
 * read any sandbox's handover credentials given the tenantId, since `platform_admin_role`
 * grants blanket SELECT on this table (migration 0137). Acceptable under the spec's §C
 * single-trusted-operator model; would become an IDOR once a second platform_admin exists.
 * `sandboxProvisioningJobs.requestedBy` already exists and is populated on insert, so adding
 * a `requestedBy = userId` filter here is a one-line change when multi-admin support lands --
 * deliberately not done now, to avoid scoping a real access-control feature ahead of need.
 */
const TenantIdParamSchema = z.object({ tenantId: z.string().uuid() });

export const sandboxHandoverHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  zValidator("param", TenantIdParamSchema),
  async (c) => {
    const { tenantId } = c.req.valid("param");
    const row = await withPlatformAdminContext((tx) =>
      tx
        .select({
          resultTenantId: sandboxProvisioningJobs.resultTenantId,
          status: sandboxProvisioningJobs.status,
        })
        .from(sandboxProvisioningJobs)
        .where(eq(sandboxProvisioningJobs.resultTenantId, tenantId))
        .limit(1),
    );
    const job = row[0];
    if (!job) {
      return c.json(
        { error: "NOT_FOUND", message: "No provisioning job for this tenant" },
        404,
      );
    }
    if (job.status !== "completed") {
      return c.json(
        {
          error: "NOT_READY",
          message: "Provisioning has not completed for this tenant yet",
        },
        409,
      );
    }
    const credentials = await getSandboxHandoverCredentials(tenantId);
    if (!credentials) {
      return c.json(
        {
          error: "NOT_FOUND",
          message: "Handover window has expired for this sandbox",
        },
        404,
      );
    }
    return c.json({ data: { tenantId, ...credentials } });
  },
);
