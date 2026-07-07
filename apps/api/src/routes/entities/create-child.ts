import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { createChildRelation } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const CreateChildSchema = z.object({
  entityTypeId: z.string().uuid(),
  fields: z.record(z.unknown()).default({}),
  assignedTo: z.string().optional(),
});

export const createChildHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  zValidator("json", CreateChildSchema),
  async (c) => {
    const parentId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const { tenantId, userId } = c.get("auth");

    try {
      const result = await withTenantContext(tenantId, (tx) =>
        createChildRelation(tx, tenantId, {
          parentId,
          entityTypeId: input.entityTypeId,
          childFields: input.fields,
          assignedTo: input.assignedTo,
          createdBy: userId,
        }),
      );
      return c.json({ data: result }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
