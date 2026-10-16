import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import {
  bulkCreateEntities,
  BULK_MAX_ITEMS,
  TicketSeveritySchema,
} from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const BulkCreateSchema = z.object({
  items: z
    .array(
      z.object({
        entityTypeId: z.string().uuid(),
        fields: z.record(z.unknown()),
        assignedTo: z.string().optional(),
        workflowId: z.string().uuid().optional(),
        // docs/specs/mandatory-ticket-fields.md R4: the rest of the five mandatory values.
        // Optional here while MANDATORY_FIELDS_MODE is "log"; the engine reports or rejects
        // an item missing them.
        teamId: z.string().uuid().optional(),
        dueDate: z.string().datetime().optional(),
        remark: z.string().trim().min(1).max(4000).optional(),
        severity: TicketSeveritySchema.optional(),
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
    const { tenantId, userId } = c.get("auth");
    const { items } = c.req.valid("json");

    try {
      const itemsWithCreator = items.map((item) => ({
        ...item,
        createdBy: userId,
      }));
      const result = await withTenantContext(tenantId, (tx) =>
        bulkCreateEntities(tx, tenantId, itemsWithCreator),
      );
      return c.json({ data: result }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
