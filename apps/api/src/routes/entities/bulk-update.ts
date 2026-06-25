import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { bulkUpdateEntities, BULK_MAX_ITEMS } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const BulkUpdateSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        fields: z.record(z.unknown()).optional(),
        assignedTo: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(BULK_MAX_ITEMS),
});

export const bulkUpdateHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  zValidator("json", BulkUpdateSchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const { items } = c.req.valid("json");

    try {
      const updates = items.map(({ id, fields, assignedTo }) => ({
        id,
        input: { fields, assignedTo },
      }));
      const result = await withTenantContext(tenantId, (tx) =>
        bulkUpdateEntities(tx, tenantId, updates),
      );
      return c.json({ data: result });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
