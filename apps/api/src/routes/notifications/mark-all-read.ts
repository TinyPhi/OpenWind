import { requireAuth, requireRole } from "@platform/auth";
import { withTenantAndUserContext, notificationRecipients } from "@platform/db";
import { eq, and, isNull } from "drizzle-orm";
import { factory } from "./factory.js";
import { broadcastReadState } from "../../websocket/notifications.js";

export const markAllNotificationsReadHandler = factory.createHandlers(
  requireAuth(),
  // Notifications are user-scoped personal data, not role-gated — see the
  // matching comment in list.ts.
  requireRole("admin", "agent", "user", "superadmin"),
  async (c) => {
    const { tenantId, userId } = c.get("auth");

    // R12: a single bulk UPDATE regardless of backlog size — never a loop of
    // per-row updates, since notifications have no expiry and can accumulate
    // over a long-lived account.
    await withTenantAndUserContext(tenantId, userId, (tx) =>
      tx
        .update(notificationRecipients)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notificationRecipients.tenantId, tenantId),
            eq(notificationRecipients.userId, userId),
            isNull(notificationRecipients.readAt),
          ),
        ),
    );

    broadcastReadState(tenantId, userId, "all");

    return c.json({ data: { read: true } });
  },
);
