import { requireAuth } from "@platform/auth";
import { db } from "@platform/db";
import { getWorkflowEventLog } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

export const listEventsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");

    try {
      const events = await getWorkflowEventLog(db, tenantId, instanceId);
      return c.json({ data: events });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
