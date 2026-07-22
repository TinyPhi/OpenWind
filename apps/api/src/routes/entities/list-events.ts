import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { getEntity, EntityError } from "@platform/entity-engine";
import { getWorkflowEventLog } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
// Same hasEntityAccess gate get.ts/list-children.ts apply to this exact
// record — without it, any tenant member can read a ticket's full comment
// thread and transition history by guessing its ID. Must be the
// workflow-admin-aware hasEntityAccess (not the plain hasEntityReadAccess),
// or a workflow admin who can GET/PATCH the record gets locked out of its
// own event log.
import { hasEntityAccess } from "../../lib/entity-access.js";

export const listEventsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const rawEventType = c.req.query("eventType");
    const eventType =
      rawEventType === "comment" || rawEventType === "history"
        ? rawEventType
        : undefined;
    const rawLimit = c.req.query("limit");
    const limit = rawLimit
      ? Math.min(parseInt(rawLimit, 10) || 50, 200)
      : undefined;

    try {
      const instance = await withTenantContext(tenantId, (tx) =>
        getEntity(tx, tenantId, instanceId),
      );

      const allowed = await withTenantContext(tenantId, (tx) =>
        hasEntityAccess(tx, tenantId, instance, userId, roles),
      );
      if (!allowed) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      const events = await withTenantContext(tenantId, (tx) =>
        getWorkflowEventLog(tx, tenantId, instanceId, {
          ...(eventType !== undefined && { eventType }),
          ...(limit !== undefined && { limit }),
        }),
      );
      return c.json({ data: events });
    } catch (err) {
      if (err instanceof EntityError) {
        return handleEntityError(c, err);
      }
      return handleWorkflowError(c, err);
    }
  },
);
