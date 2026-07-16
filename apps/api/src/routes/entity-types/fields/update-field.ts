import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { updateEntityField } from "@platform/entity-engine";
import { factory } from "../factory.js";
import { handleEntityError } from "../../../lib/handle-entity-error.js";

const UpdateFieldSchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    config: z.record(z.unknown()).optional(),
    isRequired: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
    sensitivity: z.enum(["public", "internal", "pii", "financial"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

export const updateEntityFieldHandler = factory.createHandlers(
  requireAuth(),
  // Field config (including sensitivity, which drives PII redaction/analytics
  // grants elsewhere) is schema-level, admin-only config — matches create-field.ts.
  requireRole("admin"),
  zValidator("json", UpdateFieldSchema),
  async (c) => {
    const typeId = c.get("typeId");
    const fieldId = c.req.param("fieldId") ?? "";
    const input = c.req.valid("json");
    const { tenantId } = c.get("auth");

    try {
      const field = await withTenantContext(tenantId, (tx) =>
        updateEntityField(tx, tenantId, typeId, fieldId, input),
      );
      return c.json({ data: field });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
