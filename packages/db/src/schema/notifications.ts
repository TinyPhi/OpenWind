import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /**
     * DB-enforced via a CHECK constraint (0040, extended by 0041-0043): the 6
     * fixed system triggers plus 'automation.notify' for tenant-authored
     * automation rules' notify action.
     */
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: text("link"),
    /** De-dupe marker for the outbound handoff (R16) — not a delivery guarantee. */
    outboundStatus: text("outbound_status").default("pending").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("notifications_tenant_idx").on(t.tenantId),
    tenantCreatedIdx: index("notifications_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
      t.id,
    ),
  }),
);

export const notificationRecipients = pgTable(
  "notification_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    /** NULL = unread. Private per recipient (R8). */
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("notification_recipients_tenant_idx").on(t.tenantId),
    tenantUserIdx: index("notification_recipients_tenant_user_idx").on(
      t.tenantId,
      t.userId,
      t.readAt,
    ),
    notificationUserUnique: uniqueIndex(
      "notification_recipients_notification_user_unique",
    ).on(t.notificationId, t.userId),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationRecipient = typeof notificationRecipients.$inferSelect;
export type NewNotificationRecipient =
  typeof notificationRecipients.$inferInsert;
