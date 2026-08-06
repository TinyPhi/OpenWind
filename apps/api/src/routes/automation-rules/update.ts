import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import {
  getAutomationRule,
  updateAutomationRule,
} from "@platform/automation-engine";
import type { TriggerType, ActionConfig } from "@platform/automation-engine";
import { factory } from "./factory.js";
import { handleAutomationError } from "../../lib/handle-automation-error.js";
import {
  TriggerTypeSchema,
  ActionConfigSchema,
  ConditionTreeSchema,
  TRIGGER_CONFIG_SCHEMAS,
} from "./schemas.js";

const UpdateAutomationRuleSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    isEnabled: z.boolean().optional(),
    triggerType: TriggerTypeSchema.optional(),
    triggerConfig: z.record(z.unknown()).optional(),
    conditions: ConditionTreeSchema.nullable().optional(),
    actions: z.array(ActionConfigSchema).min(1).optional(),
    priority: z.number().int().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required",
  });

function validateTriggerConfigPair(
  triggerType: string,
  triggerConfig: Record<string, unknown>,
): { issues: z.ZodIssue[] } {
  // Cast to allow undefined: DB-stored rules may have trigger types outside
  // TRIGGER_TYPES (e.g. "comment.mentioned"), which produce undefined at runtime
  // even though the non-partial Record type doesn't reflect that.
  const schema = TRIGGER_CONFIG_SCHEMAS[
    triggerType as keyof typeof TRIGGER_CONFIG_SCHEMAS
  ] as z.ZodTypeAny | undefined;
  if (!schema) return { issues: [] };
  const result = schema.safeParse(triggerConfig);
  if (result.success) return { issues: [] };
  return {
    issues: result.error.issues.map((issue) => ({
      ...issue,
      path: ["triggerConfig", ...issue.path],
    })),
  };
}

export const updateAutomationRuleHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("json", UpdateAutomationRuleSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");
    const input = c.req.valid("json");
    try {
      // Cross-field validation: when only one of triggerType / triggerConfig is
      // patched, fetch the existing rule to resolve the other half, then validate
      // the pair. Both present → validate without a DB fetch.
      if (input.triggerType && input.triggerConfig) {
        const { issues } = validateTriggerConfigPair(
          input.triggerType,
          input.triggerConfig,
        );
        if (issues.length > 0) {
          return c.json(
            {
              error: "VALIDATION_ERROR",
              message: "Invalid triggerConfig",
              fields: issues,
            },
            422,
          );
        }
      } else if (input.triggerConfig && !input.triggerType) {
        const existing = await withTenantContext(tenantId, (tx) =>
          getAutomationRule(tx, tenantId, id),
        );
        const { issues } = validateTriggerConfigPair(
          existing.triggerType,
          input.triggerConfig,
        );
        if (issues.length > 0) {
          return c.json(
            {
              error: "VALIDATION_ERROR",
              message:
                "triggerConfig is invalid for the rule's existing triggerType",
              fields: issues,
            },
            422,
          );
        }
      } else if (input.triggerType && !input.triggerConfig) {
        const existing = await withTenantContext(tenantId, (tx) =>
          getAutomationRule(tx, tenantId, id),
        );
        const { issues } = validateTriggerConfigPair(
          input.triggerType,
          existing.triggerConfig,
        );
        if (issues.length > 0) {
          return c.json(
            {
              error: "VALIDATION_ERROR",
              message:
                "Existing triggerConfig is incompatible with the new triggerType",
              fields: issues,
            },
            422,
          );
        }
      }
      const rule = await withTenantContext(tenantId, (tx) =>
        updateAutomationRule(tx, tenantId, id, {
          ...input,
          triggerType: input.triggerType as TriggerType | undefined,
          actions: input.actions as ActionConfig[] | undefined,
        }),
      );
      return c.json({ data: rule });
    } catch (err) {
      return handleAutomationError(c, err);
    }
  },
);
