import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { getWorkflowEventLog } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

export const listWorkflowEventsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");

    try {
      // TODO: add cursor-based pagination
      const events = await getWorkflowEventLog(db, tenantId, id);

      return c.json({ data: events });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
