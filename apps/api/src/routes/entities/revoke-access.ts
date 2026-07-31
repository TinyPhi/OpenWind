import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { entityInstances, withTenantContext } from "@platform/db";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { emitAccessEvent } from "../../lib/emit-access-event.js";
import { cancelUsersPendingAlertsForInstance } from "../../lib/cascade-cancel-alerts.js";

export const revokeAccessHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const targetUserId = c.req.param("userId") ?? "";
    const { tenantId, userId: actorId, roles } = c.get("auth");
    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    try {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            id: entityInstances.id,
            assignedTo: entityInstances.assignedTo,
            createdBy: entityInstances.createdBy,
            workflowId: entityInstances.workflowId,
          })
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

      if (!isPrivileged) {
        const isOwner =
          instance.createdBy === actorId || instance.assignedTo === actorId;
        const isRecordWorkflowAdmin = instance.workflowId
          ? isWorkflowAdmin(
              actorId,
              await withTenantContext(tenantId, (tx) =>
                getWorkflow(tx, tenantId, instance.workflowId as string, {
                  userId: actorId,
                  isGlobalAdmin: false,
                }),
              ),
            )
          : false;
        if (!isOwner && !isRecordWorkflowAdmin) {
          return c.json(
            { error: "NOT_FOUND", message: "Record not found" },
            404,
          );
        }
      }

      // Remove key from the __accessUsers object map using the - operator
      await withTenantContext(tenantId, (tx) =>
        tx
          .update(entityInstances)
          .set({
            fields: sql`jsonb_set(
              fields,
              '{__accessUsers}',
              COALESCE(fields->'__accessUsers', '{}') - ${targetUserId}
            )`,
            ...(instance.assignedTo === targetUserId
              ? { assignedTo: sql`NULL` }
              : {}),
          })
          .where(
            and(
              eq(entityInstances.id, id),
              eq(entityInstances.tenantId, tenantId),
            ),
          ),
      );

      void emitAccessEvent(tenantId, id, actorId, {
        type: "access_revoke",
        targetUserId,
      });
      void cancelUsersPendingAlertsForInstance(tenantId, id, targetUserId);

      return c.json({ data: { revoked: true } });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
