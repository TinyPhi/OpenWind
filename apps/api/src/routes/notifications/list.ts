import { requireAuth, requireRole } from "@platform/auth";
import {
  withTenantAndUserContext,
  notifications,
  notificationRecipients,
} from "@platform/db";
import { eq, and, or, lt, desc } from "drizzle-orm";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { ListNotificationsQuerySchema } from "./schemas.js";

function parseCursor(
  cursor: string | undefined,
): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.lastIndexOf("_");
  if (idx === -1) return null;
  const createdAt = new Date(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

export const listNotificationsHandler = factory.createHandlers(
  requireAuth(),
  // Notifications are user-scoped personal data, not a role-gated resource —
  // any recipientId (packages/automation-engine/src/actions/notify.ts) can be
  // a customer, so this must stay open to every authenticated role. Listed
  // explicitly (not just requireAuth()) per code-style's auth+role+validation
  // convention, rather than silently relying on requireAuth() alone.
  requireRole("admin", "agent", "user", "superadmin"),
  zValidator("query", ListNotificationsQuerySchema),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const { cursor, limit } = c.req.valid("query");
    const parsedCursor = parseCursor(cursor);

    const rows = await withTenantAndUserContext(tenantId, userId, (tx) =>
      tx
        .select({
          id: notifications.id,
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          link: notifications.link,
          createdAt: notifications.createdAt,
          readAt: notificationRecipients.readAt,
        })
        .from(notificationRecipients)
        .innerJoin(
          notifications,
          eq(notificationRecipients.notificationId, notifications.id),
        )
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            eq(notificationRecipients.tenantId, tenantId),
            eq(notificationRecipients.userId, userId),
            parsedCursor
              ? or(
                  lt(notifications.createdAt, parsedCursor.createdAt),
                  and(
                    eq(notifications.createdAt, parsedCursor.createdAt),
                    lt(notifications.id, parsedCursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit),
    );

    const last = rows.at(-1);
    const nextCursor = last
      ? `${last.createdAt.toISOString()}_${last.id}`
      : null;

    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        link: r.link,
        createdAt: r.createdAt,
        read: r.readAt !== null,
      })),
      nextCursor: rows.length === limit ? nextCursor : null,
    });
  },
);
