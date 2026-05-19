import { requireAuth } from "@platform/auth";
import { db } from "@platform/db";
import { getAvailableTransitions } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

export const listTransitionsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId, roles } = c.get("auth");

    const rolesParam = c.req.query("roles");
    const actorRoles = rolesParam
      ? rolesParam
          .split(",")
          .map((r) => r.trim())
          .filter((r) => roles.includes(r))
      : roles;

    try {
      const transitions = await getAvailableTransitions(
        db,
        tenantId,
        instanceId,
        actorRoles,
      );
      return c.json({ data: transitions });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
