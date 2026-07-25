import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { updateAutomationRule } from "@platform/automation-engine";
import type { TriggerType, ActionConfig } from "@platform/automation-engine";
import { factory } from "./factory.js";
import { handleAutomationError } from "../../lib/handle-automation-error.js";
import {
  TriggerTypeSchema,
  ActionConfigSchema,
  ConditionTreeSchema,
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

export const updateAutomationRuleHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("json", UpdateAutomationRuleSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");
    const input = c.req.valid("json");
    try {
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
