import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import {
  entityInstances,
  accessRequests,
  withTenantContext,
} from "@platform/db";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const RequestAccessSchema = z.object({
  requestedLevel: z
    .enum(["read_only", "read_comment", "read_write"])
    .default("read_comment"),
});

export const requestAccessHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", RequestAccessSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId: requesterId } = c.get("auth");
    const { requestedLevel } = c.req.valid("json");

    try {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ id: entityInstances.id })
          .from(entityInstances)
          .where(
            and(
              eq(entityInstances.id, id),
              eq(entityInstances.tenantId, tenantId),
            ),
          )
          .limit(1),
      );

      if (!instance) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      // Upsert: if a pending request already exists update the level,
      // otherwise insert fresh. Resolved (approved/rejected) requests are
      // left untouched — the unique partial index only covers pending rows.
      // No .limit(1) here — the unique partial index guarantees at most one
      // pending row per (tenant, instance, requester), but there can be any
      // number of already-resolved rows from prior request/reject cycles.
      // Limiting to 1 before filtering by status previously grabbed the
      // oldest row regardless of status, silently missing the real pending
      // row after a second rejection.
      const existing = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ id: accessRequests.id, status: accessRequests.status })
          .from(accessRequests)
          .where(
            and(
              eq(accessRequests.tenantId, tenantId),
              eq(accessRequests.instanceId, id),
              eq(accessRequests.requesterId, requesterId),
            ),
          ),
      );

      const pendingRow = existing.find((r) => r.status === "pending");

      if (pendingRow) {
        await withTenantContext(tenantId, (tx) =>
          tx
            .update(accessRequests)
            .set({ requestedLevel, updatedAt: new Date() })
            .where(eq(accessRequests.id, pendingRow.id)),
        );
        return c.json({ data: { id: pendingRow.id, created: false } }, 200);
      }

      const inserted = await withTenantContext(tenantId, (tx) =>
        tx
          .insert(accessRequests)
          .values({
            tenantId,
            instanceId: id,
            requesterId,
            requestedLevel,
          })
          .returning({ id: accessRequests.id }),
      );

      return c.json({ data: { id: inserted[0]?.id, created: true } }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
