import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { getWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

export const getWorkflowHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");
    try {
      const workflow = await getWorkflow(db, tenantId, id);
      return c.json({ data: workflow });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
