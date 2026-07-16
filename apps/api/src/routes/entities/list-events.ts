import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { getWorkflowEventLog } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

export const listEventsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");
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
      const events = await withTenantContext(tenantId, (tx) =>
        getWorkflowEventLog(tx, tenantId, instanceId, {
          ...(eventType !== undefined && { eventType }),
          ...(limit !== undefined && { limit }),
        }),
      );
      return c.json({ data: events });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
