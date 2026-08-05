import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { createReferenceLink, getEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

const CreateReferenceSchema = z.object({
  toInstanceId: z.string().uuid(),
});

export const createReferenceHandler = factory.createHandlers(
  requireAuth(),
  zValidator("json", CreateReferenceSchema),
  async (c) => {
    const fromInstanceId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const { tenantId, userId, roles } = c.get("auth");

    try {
      const result = await withTenantContext(tenantId, async (tx) => {
        const fromInstance = await getEntity(tx, tenantId, fromInstanceId);
        const toInstance = await getEntity(tx, tenantId, input.toInstanceId);

        // Linking must not leak the existence of a ticket the caller can't
        // otherwise see, so a missing-access check on either side is
        // indistinguishable from a not-found instance (404, never 403).
        const [canReadFrom, canReadTo] = await Promise.all([
          hasEntityAccess(tx, tenantId, fromInstance, userId, roles),
          hasEntityAccess(tx, tenantId, toInstance, userId, roles),
        ]);
        if (!canReadFrom || !canReadTo) {
          throw new Error("ENTITY_ACCESS_DENIED");
        }

        return createReferenceLink(tx, tenantId, {
          fromInstanceId,
          toInstanceId: input.toInstanceId,
        });
      });
      return c.json({ data: result.relations }, 201);
    } catch (err) {
      if (err instanceof Error && err.message === "ENTITY_ACCESS_DENIED") {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }
      return handleEntityError(c, err);
    }
  },
);
