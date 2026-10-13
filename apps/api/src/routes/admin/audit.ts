/**
 * GET /admin/audit — paginated audit log query.
 *
 * Admin-only. Supports filtering by actorId, actorType, resourceType, resourceId,
 * action, date range (from/to), and cursor-based pagination (cursor = last row
 * id; limit max 100). An unknown `action` is a 400 VALIDATION_ERROR, not an empty page. For a
 * per-resource query pass `resourceType` as well as `resourceId`: the resource
 * index is (tenant_id, resource_type, resource_id).
 */
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { queryAuditLog, ALL_AUDIT_ACTIONS } from "@platform/audit";
import type { AuditAction, AuditActorType } from "@platform/audit";
import { factory } from "./factory.js";

// z.enum needs a non-empty tuple. The list is derived from an exhaustive
// Record<AuditAction, true>, so it is never empty and holds exactly the union.
const AUDIT_ACTION_VALUES = ALL_AUDIT_ACTIONS as [
  AuditAction,
  ...AuditAction[],
];

const AuditQuerySchema = z.object({
  actorId: z.string().optional(),
  actorType: z.enum(["user", "api_key", "system"]).optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().uuid().optional(),
  action: z.enum(AUDIT_ACTION_VALUES).optional(),
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
        action: q.action,
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
