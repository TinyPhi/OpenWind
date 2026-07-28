import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { listAutomationRules } from "@platform/automation-engine";
import { factory } from "./factory.js";
import { handleAutomationError } from "../../lib/handle-automation-error.js";
import { TriggerTypeSchema } from "./schemas.js";

const ListAutomationRulesQuerySchema = z.object({
  triggerType: TriggerTypeSchema.optional(),
  enabled: z.enum(["true", "false"]).optional(),
});

export const listAutomationRulesHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("query", ListAutomationRulesQuerySchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const { triggerType, enabled } = c.req.valid("query");
    const isEnabled =
      enabled === "true" ? true : enabled === "false" ? false : undefined;

    try {
      const rules = await withTenantContext(tenantId, (tx) =>
        listAutomationRules(tx, tenantId, {
          ...(triggerType !== undefined && { triggerType }),
          ...(isEnabled !== undefined && { isEnabled }),
        }),
      );
      return c.json({ data: rules });
    } catch (err) {
      return handleAutomationError(c, err);
    }
  },
);
