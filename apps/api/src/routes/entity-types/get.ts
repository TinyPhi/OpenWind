import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { getEntityType } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

export const getEntityTypeHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");

    try {
      const entityType = await withTenantContext(tenantId, (tx) =>
        getEntityType(tx, tenantId, id),
      );
      return c.json({ data: entityType });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
