/**
 * GET /admin/system-logs — minimal viewer for system.error notifications
 * (docs/specs/in-app-notification-hub.md, T9). Deliberately small: a raw
 * queryable list, not a full observability/log-aggregation product.
 */
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext, notifications } from "@platform/db";
import { eq, and, lt, or, desc } from "drizzle-orm";
import { factory } from "./factory.js";

const SystemLogsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

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

export const getSystemLogsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("query", SystemLogsQuerySchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const { cursor, limit } = c.req.valid("query");
    const parsedCursor = parseCursor(cursor);

    const rows = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          id: notifications.id,
          title: notifications.title,
          body: notifications.body,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            eq(notifications.type, "system.error"),
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
      data: rows,
      meta: { nextCursor: rows.length === limit ? nextCursor : null },
    });
  },
);
