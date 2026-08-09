import { requireAuth, requireRole, requireIntrospection } from "@platform/auth";
import { withTenantContext, apiKeys } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import { and, eq, isNull } from "drizzle-orm";
import { factory } from "./factory.js";

export const deleteApiKeyHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  requireIntrospection(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId } = c.get("auth");

    // ADR-008 Decision #4: soft-revoke instead of a hard delete, preserving
    // the forensic record (last_used_at, that the key existed) an incident
    // investigation needs. The `isNull(revokedAt)` guard makes this idempotent
    // — an already-revoked key affects 0 rows here, same as one that never
    // existed or belongs to another tenant, so this returns 404 either way
    // rather than leaking "this key existed but was already revoked."
    const revoked = await withTenantContext(tenantId, async (tx) => {
      const rows = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date(), revokedBy: userId })
        .where(
          and(
            eq(apiKeys.id, id),
            eq(apiKeys.tenantId, tenantId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ id: apiKeys.id });

      if (rows.length > 0) {
        await writeAuditEntry(tx, {
          tenantId,
          actorId: userId,
          actorType: "user",
          resourceType: "api_key",
          resourceId: id,
          action: "deleted",
        });
      }

      return rows;
    });

    if (revoked.length === 0) {
      return c.json({ error: "NOT_FOUND", message: "API key not found" }, 404);
    }

    return c.body(null, 204);
  },
);
