import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { platformSettings } from "./schema/platform.js";
import { logger } from "@platform/logger";

/**
 * Fail-closed by design (docs/specs/outbound-notifications-kill-switch.md §R5):
 * this flag exists specifically to stop outbound traffic during an incident,
 * so a DB error or missing row must resolve to "disabled", never "enabled".
 */
export async function isOutboundNotificationsEnabled(): Promise<boolean> {
  try {
    const rows = await db
      .select({
        outboundNotificationsEnabled:
          platformSettings.outboundNotificationsEnabled,
      })
      .from(platformSettings)
      .where(eq(platformSettings.id, 1));
    return rows[0]?.outboundNotificationsEnabled ?? false;
  } catch (err) {
    logger.error(
      { err },
      "platform_settings lookup failed — failing closed, outbound notifications disabled",
    );
    return false;
  }
}
