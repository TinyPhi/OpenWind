import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { moveChildRelation } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const MoveParentSchema = z.object({
  parentId: z.string().uuid().nullable(),
});

export const moveParentHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  zValidator("json", MoveParentSchema),
  async (c) => {
    const childId = c.req.param("id") ?? "";
    const { parentId } = c.req.valid("json");
    const { tenantId } = c.get("auth");

    try {
      const relations = await withTenantContext(tenantId, (tx) =>
        moveChildRelation(tx, tenantId, {
          childId,
          newParentId: parentId,
        }),
      );
      return c.json({ data: relations });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
