import { requireAuth, requireRole } from "@platform/auth";
import { withTenantAndUserContext, notificationRecipients } from "@platform/db";
import { eq, and, isNull, count } from "drizzle-orm";
import { factory } from "./factory.js";

export const unreadNotificationCountHandler = factory.createHandlers(
  requireAuth(),
  // Notifications are user-scoped personal data, not role-gated — see the
  // matching comment in list.ts.
  requireRole("admin", "agent", "user", "superadmin"),
  async (c) => {
    const { tenantId, userId } = c.get("auth");

    const [row] = await withTenantAndUserContext(tenantId, userId, (tx) =>
      tx
        .select({ count: count() })
        .from(notificationRecipients)
        .where(
          and(
            eq(notificationRecipients.tenantId, tenantId),
            eq(notificationRecipients.userId, userId),
            isNull(notificationRecipients.readAt),
          ),
        ),
    );

    return c.json({ data: { count: row?.count ?? 0 } });
  },
);
