import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { getEntity, listEntityInstanceTags } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

export const listTagsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");

    try {
      const instance = await withTenantContext(tenantId, (tx) =>
        getEntity(tx, tenantId, id),
      );

      const allowed = await withTenantContext(tenantId, (tx) =>
        hasEntityAccess(tx, tenantId, instance, userId, roles),
      );
      if (!allowed) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      const tags = await withTenantContext(tenantId, (tx) =>
        listEntityInstanceTags(tx, tenantId, id),
      );
      return c.json({ data: tags });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
