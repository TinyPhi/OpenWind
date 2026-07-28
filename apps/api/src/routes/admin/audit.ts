/**
 * GET /admin/audit — paginated audit log query.
 *
 * Admin-only. Supports filtering by actorId, actorType, resourceType, resourceId,
 * date range (from/to), and cursor-based pagination (cursor = last row id;
 * limit max 100).
 */
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { queryAuditLog } from "@platform/audit";
import type { AuditActorType } from "@platform/audit";
import { factory } from "./factory.js";

const AuditQuerySchema = z.object({
  actorId: z.string().optional(),
  actorType: z.enum(["user", "api_key", "system"]).optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** cursor = id of the last row in the previous page */
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const getAuditLogHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("query", AuditQuerySchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const q = c.req.valid("query");

    const result = await withTenantContext(tenantId, (tx) =>
      queryAuditLog(tx, {
        tenantId,
        actorId: q.actorId,
        actorType: q.actorType as AuditActorType | undefined,
        resourceType: q.resourceType,
        resourceId: q.resourceId,
        from: q.from !== undefined ? new Date(q.from) : undefined,
        to: q.to !== undefined ? new Date(q.to) : undefined,
        cursor: q.cursor,
        limit: q.limit,
      }),
    );

    return c.json({
      data: result.entries,
      meta: {
        hasMore: result.nextCursor !== null,
        nextCursor: result.nextCursor,
      },
    });
  },
);
