import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import {
  getEntity,
  getReferenceRelation,
  deleteReferenceLink,
  EntityError,
} from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

export const deleteReferenceHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const relationId = c.req.param("relationId") ?? "";
    const { tenantId, userId, roles } = c.get("auth");

    try {
      await withTenantContext(tenantId, async (tx) => {
        // Unilateral unlink: only the caller's own access to the ticket they
        // are viewing (:id) is required, not the linked ticket on the other
        // side — either party can remove the link without counterparty consent.
        const instance = await getEntity(tx, tenantId, instanceId);
        const allowed = await hasEntityAccess(
          tx,
          tenantId,
          instance,
          userId,
          roles,
        );
        if (!allowed) throw new Error("ENTITY_ACCESS_DENIED");

        // The relation row must actually belong to the ticket being viewed —
        // otherwise a caller with access to any one ticket could delete an
        // unrelated relation elsewhere in the tenant by guessing its id.
        // listRelations(direction:"from") is what the UI uses to render a
        // ticket's own linked-tickets section, so fromInstanceId is always
        // the viewed ticket's id for a row that legitimately belongs to it.
        const relation = await getReferenceRelation(tx, tenantId, relationId);
        if (relation?.fromInstanceId !== instanceId) {
          throw new EntityError("RELATION_NOT_FOUND", { relationId });
        }

        await deleteReferenceLink(tx, tenantId, relationId, userId);
      });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof Error && err.message === "ENTITY_ACCESS_DENIED") {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }
      return handleEntityError(c, err);
    }
  },
);
