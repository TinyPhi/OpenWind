import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import {
  requirePlatformAdmin,
  invalidateTenantStatusCache,
} from "@platform/auth";
import {
  tenants,
  withPlatformAdminContext,
  setSandboxTrialEndsAt,
} from "@platform/db";
import { and, eq } from "drizzle-orm";
import { logger } from "@platform/logger";
import { platformAdminFactory } from "./factory.js";

/**
 * R6a (docs/specs/multi-org-sandbox.md): extend a sandbox's trial, or end it now.
 *
 * Extend adds `trialDays` to the later of the current trial end and now: an active trial gets
 * N more days on top of what it has; an expired (or never-set) trial runs N days from now,
 * which reactivates it -- R6's expiry check is a fresh timestamp comparison with no status
 * flag to flip back. End sets the trial end to now, so the next request is refused.
 *
 * Sandbox-only is enforced by the 0142 database function (it only updates active is_sandbox
 * rows): "not updated" covers "no such tenant", "not a sandbox" and "being deleted", all a 404
 * (security.md 404-not-403 rule). The audit entry is written in the same transaction
 * (setSandboxTrialEndsAt). Both clear the tenant-status cache (locally and, via Redis pub/sub,
 * on every replica) so the change applies to the very next request.
 *
 * Rate limiting: the global per-IP limiter (app.ts) only, same as reset/delete -- an
 * MFA-verified platform admin doing a single-row update.
 */
const TenantIdParamSchema = z.object({ tenantId: z.string().uuid() });

// Same bound as creation's trialDays (sandboxes.ts CreateSandboxSchema).
const ExtendTrialSchema = z.object({
  trialDays: z.number().int().positive().max(365),
});

const DAY_MS = 24 * 60 * 60 * 1000;

const NOT_FOUND = { error: "NOT_FOUND", message: "No such sandbox" } as const;

export const sandboxTrialHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  zValidator("param", TenantIdParamSchema),
  zValidator("json", ExtendTrialSchema),
  async (c) => {
    const { userId } = c.get("platformAdmin");
    const { tenantId } = c.req.valid("param");
    const { trialDays } = c.req.valid("json");

    // Read only to pick the base date; the update itself is still guarded by the function.
    const [current] = await withPlatformAdminContext((tx) =>
      tx
        .select({ trialEndsAt: tenants.trialEndsAt })
        .from(tenants)
        .where(and(eq(tenants.id, tenantId), eq(tenants.isSandbox, true)))
        .limit(1),
    );
    if (!current) return c.json(NOT_FOUND, 404);

    const now = Date.now();
    const base = Math.max(now, current.trialEndsAt?.getTime() ?? now);
    const trialEndsAt = new Date(base + trialDays * DAY_MS);

    const updated = await setSandboxTrialEndsAt(tenantId, trialEndsAt, userId);
    if (!updated) return c.json(NOT_FOUND, 404);

    invalidateTenantStatusCache(tenantId);
    logger.info(
      { tenantId, trialDays, trialEndsAt: trialEndsAt.toISOString() },
      "Sandbox trial extended",
    );
    return c.json({ data: { trialEndsAt: trialEndsAt.toISOString() } });
  },
);

export const sandboxTrialEndHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  zValidator("param", TenantIdParamSchema),
  async (c) => {
    const { userId } = c.get("platformAdmin");
    const { tenantId } = c.req.valid("param");

    const trialEndsAt = new Date();
    const updated = await setSandboxTrialEndsAt(
      tenantId,
      trialEndsAt,
      userId,
      "sandbox.trial_ended",
    );
    if (!updated) return c.json(NOT_FOUND, 404);

    invalidateTenantStatusCache(tenantId);
    logger.info(
      { tenantId, trialEndsAt: trialEndsAt.toISOString() },
      "Sandbox trial ended",
    );
    return c.json({ data: { trialEndsAt: trialEndsAt.toISOString() } });
  },
);
