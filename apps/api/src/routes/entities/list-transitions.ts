import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { getEntity, EntityError } from "@platform/entity-engine";
import { getAvailableTransitions } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
// Same hasEntityReadAccess gate get.ts/list-events.ts apply to this exact
// record — without it, any tenant member can discover a ticket's available
// transitions (and thus indirectly its current state) by guessing its ID.
import { hasEntityReadAccess } from "../../lib/entity-access.js";

export const listTransitionsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");

    const rolesParam = c.req.query("roles");
    const actorRoles = rolesParam
      ? rolesParam
          .split(",")
          .map((r) => r.trim())
          .filter((r) => roles.includes(r))
      : roles;

    try {
      const instance = await withTenantContext(tenantId, (tx) =>
        getEntity(tx, tenantId, instanceId),
      );

      if (!hasEntityReadAccess(instance, userId, roles)) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      const transitions = await withTenantContext(tenantId, (tx) =>
        getAvailableTransitions(tx, tenantId, instanceId, actorRoles),
      );
      return c.json({ data: transitions });
    } catch (err) {
      if (err instanceof EntityError) {
        return handleEntityError(c, err);
      }
      return handleWorkflowError(c, err);
    }
  },
);
