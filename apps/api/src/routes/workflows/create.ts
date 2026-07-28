import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { createWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

const CreateWorkflowSchema = z.object({
  entityTypeId: z.string().uuid(),
  name: z.string().min(1).max(200),
  initialState: z.string().min(1).max(100),
});

export const createWorkflowHandler = factory.createHandlers(
  requireAuth(),
  // admin/agent only (issue #168): workflows(tenant_id, entity_type_id) is
  // UNIQUE (migration 0036), so whoever creates a workflow for an entity
  // type wins that entity type permanently — opening creation to plain
  // `user`-role callers would let any tenant member race to squat a
  // freshly-created entity type before its intended owner claims it.
  // `user`-role delegation still works exactly as designed: an admin/agent
  // creates the workflow, then adds the intended owner's userId to
  // assignedTo[] via updateWorkflow — that grant is unaffected by this gate.
  requireRole("admin", "agent"),
  zValidator("json", CreateWorkflowSchema),
  async (c) => {
    const input = c.req.valid("json");
    const { tenantId, userId } = c.get("auth");
    try {
      const workflow = await withTenantContext(tenantId, (tx) =>
        createWorkflow(tx, tenantId, userId, input),
      );
      return c.json({ data: workflow }, 201);
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
