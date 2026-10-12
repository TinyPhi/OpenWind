import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import { requirePlatformAdmin } from "@platform/auth";
import { listPlatformAdminAuditLog } from "@platform/db";
import { platformAdminFactory } from "./factory.js";

/**
 * T16 (docs/specs/multi-org-sandbox.md), ADR-022 Decision 7. Read-only surface over
 * platform_admin_audit_log -- see @platform/db's listPlatformAdminAuditLog for the
 * keyset-pagination shape and migration 0140 for why this table carries no tenant_id/RLS.
 */
const AuditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().uuid().optional(),
});

export const auditLogHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  zValidator("query", AuditLogQuerySchema),
  async (c) => {
    const { limit, before } = c.req.valid("query");
    const entries = await listPlatformAdminAuditLog({ limit, before });
    return c.json({ data: entries });
  },
);
