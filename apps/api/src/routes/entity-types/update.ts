import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { updateEntityType } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const UpdateEntityTypeSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    plural: z.string().min(1).max(100).optional(),
    icon: z.string().nullable().optional(),
    allowCustomFields: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

export const updateEntityTypeHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("json", UpdateEntityTypeSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const { tenantId } = c.get("auth");

    try {
      const entityType = await withTenantContext(tenantId, (tx) =>
        updateEntityType(tx, tenantId, id, input),
      );
      return c.json({ data: entityType });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
