import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { listWorkflowSlugs } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

// Deliberately not ownership-filtered — see listWorkflowSlugs' doc comment.
export const listWorkflowSlugsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const { tenantId } = c.get("auth");
    try {
      const rows = await withTenantContext(tenantId, (tx) =>
        listWorkflowSlugs(tx, tenantId),
      );
      return c.json({ data: rows });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
