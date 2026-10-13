import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import {
  requirePlatformAdmin,
  invalidateTenantStatusCache,
} from "@platform/auth";
import {
  tenants,
  withPlatformAdminContext,
  extendSandboxTrial,
  endSandboxTrial,
} from "@platform/db";
import { and, eq } from "drizzle-orm";
import { logger } from "@platform/logger";
import { platformAdminFactory } from "./factory.js";

/**
 * R6a (docs/specs/multi-org-sandbox.md): extend a sandbox's trial, or end a running one now.
 *
 * Both go through 0142's SECURITY DEFINER functions, which only ever update active is_sandbox
 * rows and compute the new end inside a single UPDATE -- so concurrent extends stack instead of
 * overwriting each other (PR #880 review B), and End can only end a trial that is running, never
 * turn a sandbox with no trial into an expired one (review C). The R9 audit entry is written in
 * the same transaction (extendSandboxTrial / endSandboxTrial). Both clear the tenant-status cache
 * (locally and, via Redis pub/sub, on every replica) so the change applies to the next request.
 *
 * Rate limiting: the global per-IP limiter (app.ts) only, same as reset/delete -- an
 * MFA-verified platform admin doing a single-row update.
 */
const TenantIdParamSchema = z.object({ tenantId: z.string().uuid() });

// Same bound as creation's trialDays (sandboxes.ts CreateSandboxSchema).
const ExtendTrialSchema = z.object({
  trialDays: z.number().int().positive().max(365),
});

const NOT_FOUND = { error: "NOT_FOUND", message: "No such sandbox" } as const;
const NO_ACTIVE_TRIAL = {
  error: "NO_ACTIVE_TRIAL",
  message: "This sandbox has no running trial to end",
} as const;

export const sandboxTrialHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  zValidator("param", TenantIdParamSchema),
  zValidator("json", ExtendTrialSchema),
  async (c) => {
    const { userId } = c.get("platformAdmin");
    const { tenantId } = c.req.valid("param");
    const { trialDays } = c.req.valid("json");

    // "Not updated" covers no such tenant, not a sandbox, and being deleted: all a 404
    // (security.md 404-not-403 rule).
    const trialEndsAt = await extendSandboxTrial(tenantId, trialDays, userId);
    if (!trialEndsAt) return c.json(NOT_FOUND, 404);

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

    // Read only to tell "no such sandbox" (404) from "no running trial" (409); the end
    // function re-checks both, so a change in between still can't end the wrong thing.
    const [current] = await withPlatformAdminContext((tx) =>
      tx
        .select({ trialEndsAt: tenants.trialEndsAt })
        .from(tenants)
        .where(and(eq(tenants.id, tenantId), eq(tenants.isSandbox, true)))
        .limit(1),
    );
    if (!current) return c.json(NOT_FOUND, 404);
    if (!current.trialEndsAt || current.trialEndsAt.getTime() <= Date.now()) {
      return c.json(NO_ACTIVE_TRIAL, 409);
    }

    const trialEndsAt = await endSandboxTrial(tenantId, userId);
    if (!trialEndsAt) return c.json(NO_ACTIVE_TRIAL, 409);

    invalidateTenantStatusCache(tenantId);
    logger.info(
      { tenantId, trialEndsAt: trialEndsAt.toISOString() },
      "Sandbox trial ended",
    );
    return c.json({ data: { trialEndsAt: trialEndsAt.toISOString() } });
  },
);
