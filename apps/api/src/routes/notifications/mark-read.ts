import { requireAuth } from "@platform/auth";
import { withTenantAndUserContext, notificationRecipients } from "@platform/db";
import { eq, and, sql } from "drizzle-orm";
import { factory } from "./factory.js";
import { broadcastReadState } from "../../websocket/notifications.js";

export const markNotificationReadHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const id = c.req.param("id") ?? "";

    // COALESCE keeps the original read_at if already read — re-marking read
    // is idempotent, not a no-op 404 (this row exists; it's just already
    // read, which isn't an error).
    const [updated] = await withTenantAndUserContext(tenantId, userId, (tx) =>
      tx
        .update(notificationRecipients)
        .set({ readAt: sql`COALESCE(${notificationRecipients.readAt}, now())` })
        .where(
          and(
            eq(notificationRecipients.notificationId, id),
            eq(notificationRecipients.tenantId, tenantId),
            eq(notificationRecipients.userId, userId),
          ),
        )
        .returning(),
    );

    if (!updated) {
      return c.json(
        { error: "NOT_FOUND", message: "Notification not found" },
        404,
      );
    }

    // Live-sync (R10): a user's other open tabs/connections update without a
    // manual refresh.
    broadcastReadState(tenantId, userId, [id]);

    return c.json({ data: { read: true } });
  },
);
