import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { createRelation } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { assertRecordWorkflowAccess } from "../../lib/assert-record-workflow-access.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";

const CreateRelationSchema = z.object({
  toInstanceId: z.string().uuid(),
  relationType: z.string().min(1).max(100),
});

export const createRelationHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateRelationSchema),
  async (c) => {
    const fromInstanceId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const auth = c.get("auth");
    const { tenantId } = auth;
    // "agent" is a tenant-wide role that already links tickets freely
    // (matches the pre-existing requireRole("admin","agent") contract);
    // only "user" callers are subject to the extra full-access check below —
    // creator, assignee, or workflow admin of the *source* ticket.
    const isAgentOrAdmin =
      auth.roles.includes("admin") || auth.roles.includes("agent");
    const caller = toWorkflowCaller(auth);

    try {
      const relation = await withTenantContext(tenantId, async (tx) => {
        if (!isAgentOrAdmin) {
          await assertRecordWorkflowAccess(
            tx,
            tenantId,
            fromInstanceId,
            caller,
          );
        }
        return createRelation(tx, tenantId, {
          fromInstanceId,
          toInstanceId: input.toInstanceId,
          relationType: input.relationType,
          actorId: auth.userId,
        });
      });
      return c.json({ data: relation }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
