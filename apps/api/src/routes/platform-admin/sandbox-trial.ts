import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import {
  requirePlatformAdmin,
  invalidateTenantStatusCache,
} from "@platform/auth";
import { setSandboxTrialEndsAt } from "@platform/db";
import { logger } from "@platform/logger";
import { platformAdminFactory } from "./factory.js";

/**
 * R6a (docs/specs/multi-org-sandbox.md): sets a sandbox's trial to end `trialDays` from now.
 * On an expired sandbox this is a reactivation -- R6's expiry check is a fresh timestamp
 * comparison with no status flag to flip back, so a future trial_ends_at is all it takes.
 *
 * Sandbox-only is enforced by the 0142 database function (it only updates active is_sandbox
 * rows), so there's no separate pre-check here: "not updated" covers "no such tenant", "not a
 * sandbox" and "being deleted", all a 404 (security.md 404-not-403 rule). The audit entry is
 * written in the same transaction (setSandboxTrialEndsAt).
 *
 * Rate limiting: the global per-IP limiter (app.ts) only, same as reset/delete -- an
 * MFA-verified platform admin doing a single-row update.
 */
const TenantIdParamSchema = z.object({ tenantId: z.string().uuid() });

// Same bound as creation's trialDays (sandboxes.ts CreateSandboxSchema).
const SetTrialSchema = z.object({
  trialDays: z.number().int().positive().max(365),
});

const DAY_MS = 24 * 60 * 60 * 1000;

export const sandboxTrialHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  zValidator("param", TenantIdParamSchema),
  zValidator("json", SetTrialSchema),
  async (c) => {
    const { userId } = c.get("platformAdmin");
    const { tenantId } = c.req.valid("param");
    const { trialDays } = c.req.valid("json");

    const trialEndsAt = new Date(Date.now() + trialDays * DAY_MS);
    const updated = await setSandboxTrialEndsAt(tenantId, trialEndsAt, userId);
    if (!updated) {
      return c.json({ error: "NOT_FOUND", message: "No such sandbox" }, 404);
    }

    // The auth middleware caches trial_ends_at for 30 s; drop it (locally and, via Redis
    // pub/sub, on every replica) so a reactivated sandbox's users can log in straight away.
    invalidateTenantStatusCache(tenantId);

    logger.info(
      { tenantId, trialDays, trialEndsAt: trialEndsAt.toISOString() },
      "Sandbox trial updated",
    );
    return c.json({ data: { trialEndsAt: trialEndsAt.toISOString() } });
  },
);
