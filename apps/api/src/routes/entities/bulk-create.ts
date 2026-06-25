import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { bulkCreateEntities, BULK_MAX_ITEMS } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const BulkCreateSchema = z.object({
  items: z
    .array(
      z.object({
        entityTypeId: z.string().uuid(),
        fields: z.record(z.unknown()),
        createdBy: z.string().optional(),
        assignedTo: z.string().optional(),
        workflowId: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(BULK_MAX_ITEMS),
});

export const bulkCreateHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  zValidator("json", BulkCreateSchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const { items } = c.req.valid("json");

    try {
      const result = await withTenantContext(tenantId, (tx) =>
        bulkCreateEntities(tx, tenantId, items),
      );
      return c.json({ data: result }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
