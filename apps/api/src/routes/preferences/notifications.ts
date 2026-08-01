/**
 * Notification preference routes (user-scoped, tenant-scoped).
 *
 * GET  /preferences/notifications  — current user's channel preferences
 * PATCH /preferences/notifications  — update current user's preferences
 */
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import {
  getUserPreferences,
  updateUserPreferences,
  type NotificationPreferences,
} from "@platform/notifications";
import { factory } from "./factory.js";

const ChannelOverridesSchema = z.object({
  email: z.boolean().optional(),
  inApp: z.boolean().optional(),
  sms: z.boolean().optional(),
});

const PreferencesPatchSchema = z.object({
  channels: z
    .object({
      email: z.boolean().optional(),
      inApp: z.boolean().optional(),
      sms: z.boolean().optional(),
    })
    .optional(),
  templateOverrides: z.record(ChannelOverridesSchema).optional(),
});

export const getNotificationPrefsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const prefs = await withTenantContext(tenantId, (tx) =>
      getUserPreferences(tx, tenantId, userId),
    );
    return c.json({ data: prefs });
  },
);

export const updateNotificationPrefsHandler = factory.createHandlers(
  requireAuth(),
  zValidator("json", PreferencesPatchSchema),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const input = c.req.valid("json");
    // Zod optional() adds `| undefined` to each property, but the function
    // signature uses exactOptionalPropertyTypes — cast through unknown.
    const updated = await withTenantContext(tenantId, (tx) =>
      updateUserPreferences(
        tx,
        tenantId,
        userId,
        input as Partial<NotificationPreferences>,
      ),
    );
    return c.json({ data: updated });
  },
);
