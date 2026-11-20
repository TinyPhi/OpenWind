/**
 * Tenant settings routes — per-tenant organization configuration (#1158).
 *
 * GET   /admin/tenant-settings — read the tenant's settings (readable by authenticated tenant users)
 * PATCH /admin/tenant-settings — update the tenant's settings (admin only)
 */

import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { tenantSettings, withTenantContext } from "@platform/db";
import { isValidTimezone } from "@platform/scheduler";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";

export const PatchTenantSettingsSchema = z.object({
  defaultTimezone: z
    .string()
    .nullable()
    .refine((tz) => tz === null || isValidTimezone(tz), {
      message: "Invalid IANA timezone identifier",
    }),
});

export const getTenantSettingsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const { tenantId } = c.get("auth");
    try {
      const data = await withTenantContext(tenantId, async (tx) => {
        const [row] = await tx
          .select({
            defaultTimezone: tenantSettings.defaultTimezone,
          })
          .from(tenantSettings)
          .where(eq(tenantSettings.tenantId, tenantId))
          .limit(1);

        return {
          defaultTimezone: row?.defaultTimezone ?? null,
        };
      });

      return c.json({ data });
    } catch (err: unknown) {
      logger.error({ err, tenantId }, "getTenantSettings failed");
      return c.json(
        { error: "INTERNAL_ERROR", message: "Failed to load tenant settings" },
        500,
      );
    }
  },
);

export const updateTenantSettingsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("json", PatchTenantSettingsSchema),
  async (c) => {
    const { defaultTimezone } = c.req.valid("json");
    const { userId, tenantId } = c.get("auth");

    try {
      const data = await withTenantContext(tenantId, async (tx) => {
        const [before] = await tx
          .select({
            defaultTimezone: tenantSettings.defaultTimezone,
          })
          .from(tenantSettings)
          .where(eq(tenantSettings.tenantId, tenantId))
          .limit(1);

        const [row] = await tx
          .insert(tenantSettings)
          .values({
            tenantId,
            defaultTimezone,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: tenantSettings.tenantId,
            set: {
              defaultTimezone,
              updatedAt: new Date(),
            },
          })
          .returning();

        if (!row) {
          throw new Error("Failed to save tenant settings");
        }

        await writeAuditEntry(tx, {
          tenantId,
          actorId: userId,
          actorType: "user",
          resourceType: "tenant_settings",
          resourceId: tenantId,
          action: "updated",
          beforeSnapshot: { defaultTimezone: before?.defaultTimezone ?? null },
          afterSnapshot: { defaultTimezone: row.defaultTimezone },
        });

        return {
          defaultTimezone: row.defaultTimezone,
        };
      });

      return c.json({ data });
    } catch (err: unknown) {
      logger.error({ err, tenantId }, "updateTenantSettings failed");
      return c.json(
        {
          error: "INTERNAL_ERROR",
          message: "Failed to update tenant settings",
        },
        500,
      );
    }
  },
);
