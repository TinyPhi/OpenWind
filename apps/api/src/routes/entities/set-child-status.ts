import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { getParentId, updateEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const SetChildStatusSchema = z.object({
  status: z.enum(["open", "closed"]),
});

// Deliberate #127-class bypass: this mutates current_state directly
// (no transition validation, no workflow_events row beyond updateEntity's
// own, no automation trigger via workflow.transitioned) rather than going
// through the workflow engine's executeTransition. Restricting to
// admin/agent is the guard for that — previously any ticket owner/assignee
// or read_write ACL holder could flip state through this side-door.
export const setChildStatusHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  zValidator("json", SetChildStatusSchema),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { status } = c.req.valid("json");
    const { tenantId, userId } = c.get("auth");

    try {
      // Verify this is actually a child ticket
      const parentId = await withTenantContext(tenantId, (tx) =>
        getParentId(tx, tenantId, instanceId),
      );
      if (!parentId) {
        return c.json(
          {
            error: "NOT_A_CHILD_TICKET",
            message:
              "This ticket has no parent — child-status only applies to child tickets",
          },
          422,
        );
      }
      const instance = await withTenantContext(tenantId, (tx) =>
        updateEntity(tx, tenantId, instanceId, {
          currentState: status,
          fields: { child_status: status },
          actorId: userId,
          actorType: "user",
        }),
      );
      return c.json({ data: instance });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
