import { requireAuth, requireRole, requireIntrospection } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { deleteEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

export const deleteEntityHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  requireIntrospection(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId } = c.get("auth");

    try {
      await withTenantContext(tenantId, (tx) =>
        deleteEntity(tx, tenantId, id, userId),
      );
      return c.body(null, 204);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
