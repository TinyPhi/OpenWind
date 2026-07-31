/**
 * Platform settings routes — single-row global platform config
 * (docs/specs/outbound-notifications-kill-switch.md).
 *
 * GET   /admin/platform-settings — current global config
 * PATCH /admin/platform-settings — update global config (admin only)
 */
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { db, platformSettings } from "@platform/db";
import { eq } from "drizzle-orm";
import { logger } from "@platform/logger";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";

const PlatformSettingsPatchSchema = z.object({
  outboundNotificationsEnabled: z.boolean(),
});

export const getPlatformSettingsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("superadmin"),
  async (c) => {
    const [row] = await db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.id, 1));

    // Fail-closed to match isOutboundNotificationsEnabled's default if the
    // seed row is somehow missing.
    return c.json({
      data: {
        outboundNotificationsEnabled:
          row?.outboundNotificationsEnabled ?? false,
      },
    });
  },
);

export const updatePlatformSettingsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("superadmin"),
  zValidator("json", PlatformSettingsPatchSchema),
  async (c) => {
    const { outboundNotificationsEnabled } = c.req.valid("json");
    const { userId } = c.get("auth");

    try {
      const [row] = await db
        .update(platformSettings)
        .set({
          outboundNotificationsEnabled,
          updatedAt: new Date(),
          updatedBy: userId,
        })
        .where(eq(platformSettings.id, 1))
        .returning();

      // The row is guaranteed by the migration's seed insert + id=1 CHECK,
      // so a missing row here means something is badly wrong — surface it
      // rather than returning a misleading 200 with an empty body (which
      // would look like a successful update that silently changed nothing).
      if (!row) {
        logger.error(
          {},
          "updatePlatformSettings: singleton row missing after update",
        );
        return c.json(
          {
            error: "PLATFORM_SETTINGS_ROW_MISSING",
            message: "Failed to update platform settings",
          },
          500,
        );
      }

      return c.json({ data: row });
    } catch (err: unknown) {
      logger.error({ err }, "updatePlatformSettings failed");
      return c.json(
        {
          error: "PLATFORM_SETTINGS_UPDATE_FAILED",
          message: "Failed to update platform settings",
        },
        500,
      );
    }
  },
);
