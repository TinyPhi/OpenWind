import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import { requirePlatformAdmin } from "@platform/auth";
import { withPlatformAdminContext, checkSandboxQuota } from "@platform/db";
import { env } from "@platform/config";
import { sandboxProvisioningQueue } from "../../lib/sandbox-provisioning-queue.js";
import { enforceSandboxProvisioningRateLimit } from "../../lib/rate-limit-tiers.js";
import { platformAdminFactory } from "./factory.js";

/**
 * T7 (docs/specs/multi-org-sandbox.md Phase 2) — starts a sandbox provisioning job.
 * Returns only a job id; the wait-screen polling endpoint (T8) and the handover endpoint
 * (T21) are separate, not-yet-built follow-ups — this route's job is only to kick off the
 * trackable job (R5), after confirming the requesting platform_admin is under R11's quota.
 *
 * The quota check reads `tenants` under platform_admin_role (column-scoped SELECT, R2) — it
 * only counts rows, it does not reserve a slot (packages/db/src/platform-admin-view.ts's own
 * doc comment), so two concurrent requests from the same platform_admin can still race past
 * the limit by a small margin. Acceptable for a single-trusted-operator v1 (§C) and no worse
 * than the pre-existing behaviour this route introduces.
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

    const job = await sandboxProvisioningQueue.add("provision", {
      orgName,
      trialDays,
      requestedBy: userId,
    });

    return c.json({ data: { jobId: job.id } }, 202);
  },
);
