import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { restoreEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

export const restoreEntityHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");

    try {
      const result = await withTenantContext(tenantId, (tx) =>
        restoreEntity(tx, tenantId, instanceId),
      );
      return c.json({ data: result });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
