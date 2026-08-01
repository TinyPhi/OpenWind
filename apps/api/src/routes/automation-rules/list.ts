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
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listAutomationRulesHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("query", ListAutomationRulesQuerySchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const { triggerType, enabled, limit, offset } = c.req.valid("query");
    const isEnabled =
      enabled === "true" ? true : enabled === "false" ? false : undefined;

    try {
      const rules = await withTenantContext(tenantId, (tx) =>
        listAutomationRules(tx, tenantId, {
          ...(triggerType !== undefined && { triggerType }),
          ...(isEnabled !== undefined && { isEnabled }),
          limit,
          offset,
        }),
      );
      return c.json({ data: rules });
    } catch (err) {
      return handleAutomationError(c, err);
    }
  },
);
