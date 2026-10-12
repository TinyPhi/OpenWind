import { writeAuditEntry } from "@platform/audit";
import { withTenantContext } from "@platform/db";
import { logger } from "@platform/logger";

/**
 * Best-effort audit of a same-tenant ACL denial on a first-party ticket route
 * (#640), mirroring the third-party routes' denied branch. Call only after a
 * record was found and the caller's access check failed — never for a missing
 * id — and keep the 404 response unchanged. An audit failure must not turn the
 * 404 into a 500, so it is logged and swallowed.
 *
 * Writes one row per denied request, with no dedup or cap of its own. The bound
 * on that volume is the API's per-tenant rate limiter (ADR-013), and the rows
 * roll up under the 90-day access-log retention sweep.
 */
export async function auditTicketAccessDenied(input: {
  tenantId: string;
  userId: string;
  instanceId: string;
  action: "ticket.view_denied" | "comment.access_denied";
}): Promise<void> {
  try {
    await withTenantContext(input.tenantId, (tx) =>
      writeAuditEntry(tx, {
        tenantId: input.tenantId,
        actorId: input.userId,
        actorType: "user",
        resourceType: "ticket",
        resourceId: input.instanceId,
        action: input.action,
      }),
    );
  } catch (auditErr) {
    logger.warn(
      {
        auditErr,
        tenantId: input.tenantId,
        instanceId: input.instanceId,
        action: input.action,
      },
      "first-party ticket denial audit write failed",
    );
  }
}
