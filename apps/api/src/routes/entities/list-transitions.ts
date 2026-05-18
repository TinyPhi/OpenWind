import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { getAvailableTransitions } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

export const listTransitionsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, roles } = c.get("auth");

    try {
      const transitions = await getAvailableTransitions(
        db,
        tenantId,
        id,
        roles,
      );
      return c.json({ data: transitions });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
