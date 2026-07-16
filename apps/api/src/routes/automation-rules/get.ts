import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { getAutomationRule } from "@platform/automation-engine";
import { factory } from "./factory.js";
import { handleAutomationError } from "../../lib/handle-automation-error.js";

export const getAutomationRuleHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");
    try {
      const rule = await withTenantContext(tenantId, (tx) =>
        getAutomationRule(tx, tenantId, id),
      );
      return c.json({ data: rule });
    } catch (err) {
      return handleAutomationError(c, err);
    }
  },
);
