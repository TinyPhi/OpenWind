import { zValidator } from "../../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import {
  addEntityField,
  FIELD_TYPES,
  isSafeRegex,
} from "@platform/entity-engine";
import { factory } from "../factory.js";
import { handleEntityError } from "../../../lib/handle-entity-error.js";
import { assertFieldWorkflowAccess } from "../../../lib/assert-field-workflow-access.js";
import { toWorkflowCaller } from "../../../lib/workflow-caller.js";

const CreateFieldSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z_][a-z0-9_]*$/, "field name must be snake_case"),
  label: z.string().min(1).max(200),
  fieldType: z.enum(FIELD_TYPES),
  config: z.record(z.unknown()).default({}),
  isRequired: z.boolean().default(false),
  isIndexed: z.boolean().default(false),
  sortOrder: z.number().int().min(0).default(0),
  sensitivity: z
    .enum(["public", "internal", "pii", "financial"])
    .default("internal"),
});

export const createEntityFieldHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateFieldSchema),
  async (c) => {
    const typeId = c.get("typeId");
    const input = c.req.valid("json");
    const auth = c.get("auth");
    const { tenantId } = auth;
    const caller = toWorkflowCaller(auth);

    // ReDoS guard: zValidator uses synchronous safeParse so async superRefine
    // would not run there.  We check the pattern here after basic validation
    // passes, at config-save time only (not on the validation hot-path).
    const pattern = input.config["pattern"];
    if (
      input.fieldType === "text" &&
      typeof pattern === "string" &&
      pattern.length > 0
    ) {
      const safe = await isSafeRegex(pattern);
      if (!safe) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: [
              {
                field: "config.pattern",
                code: "INVALID_FORMAT",
                message:
                  "Pattern is invalid or vulnerable to ReDoS — use a simpler regex",
              },
            ],
          },
          422,
        );
      }
    }

    try {
      const field = await withTenantContext(tenantId, async (tx) => {
        await assertFieldWorkflowAccess(tx, tenantId, typeId, caller);
        return addEntityField(tx, tenantId, typeId, {
          entityTypeId: typeId,
          name: input.name,
          label: input.label,
          fieldType: input.fieldType,
          config: input.config,
          isRequired: input.isRequired,
          isIndexed: input.isIndexed,
          isSystem: false,
          sortOrder: input.sortOrder,
          sensitivity: input.sensitivity,
          createdAt: new Date(),
        });
      });
      return c.json({ data: field }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
