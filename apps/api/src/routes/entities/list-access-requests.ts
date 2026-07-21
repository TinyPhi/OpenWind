import { eq, and } from "drizzle-orm";
import { requireAuth } from "@platform/auth";
import {
  entityInstances,
  accessRequests,
  withTenantContext,
} from "@platform/db";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

export const listAccessRequestsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const isAdminOrAgent = roles.includes("admin") || roles.includes("agent");

    try {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            createdBy: entityInstances.createdBy,
            assignedTo: entityInstances.assignedTo,
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

      const isOwner =
        instance.createdBy === userId || instance.assignedTo === userId;
      const isRecordWorkflowAdmin = instance.workflowId
        ? isWorkflowAdmin(
            userId,
            await withTenantContext(tenantId, (tx) =>
              getWorkflow(tx, tenantId, instance.workflowId as string, {
                userId,
                isGlobalAdmin: false,
              }),
            ),
          )
        : false;
      if (!isOwner && !isAdminOrAgent && !isRecordWorkflowAdmin) {
        return c.json({ error: "FORBIDDEN", message: "Not found" }, 404);
      }

      const rows = await withTenantContext(tenantId, (tx) =>
        tx
          .select()
          .from(accessRequests)
          .where(
            and(
              eq(accessRequests.tenantId, tenantId),
              eq(accessRequests.instanceId, id),
            ),
          )
          .orderBy(accessRequests.createdAt),
      );

      return c.json({ data: rows });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
