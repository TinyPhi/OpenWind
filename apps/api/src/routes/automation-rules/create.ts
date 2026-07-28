import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { createAutomationRule } from "@platform/automation-engine";
import type { TriggerType, ActionConfig } from "@platform/automation-engine";
import { factory } from "./factory.js";
import { handleAutomationError } from "../../lib/handle-automation-error.js";
import {
  TriggerTypeSchema,
  ActionConfigSchema,
  ConditionTreeSchema,
} from "./schemas.js";

const CreateAutomationRuleSchema = z.object({
  name: z.string().min(1).max(200),
  triggerType: TriggerTypeSchema,
  triggerConfig: z.record(z.unknown()),
  conditions: ConditionTreeSchema.nullable().optional(),
  actions: z.array(ActionConfigSchema).min(1),
  isEnabled: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export const createAutomationRuleHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("json", CreateAutomationRuleSchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const input = c.req.valid("json");
    try {
      const rule = await withTenantContext(tenantId, (tx) =>
        createAutomationRule(tx, tenantId, {
          ...input,
          triggerType: input.triggerType as TriggerType,
          actions: input.actions as ActionConfig[],
        }),
      );
      return c.json({ data: rule }, 201);
    } catch (err) {
      return handleAutomationError(c, err);
    }
  },
);
