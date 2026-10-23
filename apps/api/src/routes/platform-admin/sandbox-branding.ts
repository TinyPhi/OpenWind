import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import { requirePlatformAdmin } from "@platform/auth";
import { setSandboxBranding, toPlatformAdminSandboxView } from "@platform/db";
import { logger } from "@platform/logger";
import { SandboxLogoSchema } from "../../lib/sandbox-logo.js";
import { platformAdminFactory } from "./factory.js";

/**
 * R12 (docs/specs/multi-org-sandbox.md): set a sandbox's display name and/or logo.
 *
 * Goes through 0155's SECURITY DEFINER function, which only ever updates active is_sandbox rows
 * and re-checks the name length; the R9 audit entry is written in the same transaction
 * (setSandboxBranding). The logo is validated here (type, size, leading bytes) and again by
 * tenants_logo_check, so a bug in either still can't store a non-raster image.
 *
 * Needs the sign-in's verified MFA flag only (requirePlatformAdmin), the same tier as trial
 * changes. The status cache holds status and trial only, so there is nothing to invalidate.
 *
 * Rate limiting: the global per-IP limiter (app.ts) only, same as the trial routes.
 */
const TenantIdParamSchema = z.object({ tenantId: z.string().uuid() });

const BrandingSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    logo: SandboxLogoSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.logo !== undefined, {
    message: "Provide a name, a logo, or both",
  });

const NOT_FOUND = { error: "NOT_FOUND", message: "No such sandbox" } as const;

export const sandboxBrandingHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  zValidator("param", TenantIdParamSchema),
  zValidator("json", BrandingSchema),
  async (c) => {
    const { userId } = c.get("platformAdmin");
    const { tenantId } = c.req.valid("param");
    const change = c.req.valid("json");

    // "Not updated" covers no such tenant, not a sandbox, and being deleted: all a 404
    // (security.md 404-not-403 rule).
    const row = await setSandboxBranding(tenantId, change, userId);
    if (!row) return c.json(NOT_FOUND, 404);

    logger.info(
      {
        tenantId,
        nameChanged: change.name !== undefined,
        logoChanged: change.logo !== undefined,
      },
      "Sandbox branding changed",
    );
    return c.json({ data: toPlatformAdminSandboxView(row) });
  },
);
