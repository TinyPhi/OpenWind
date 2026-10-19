import { zValidator } from "../../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { workflowTransitions, withTenantContext } from "@platform/db";
import { and, eq } from "drizzle-orm";
import { updateWorkflowTransition } from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { TransitionConditionsSchema } from "./condition-schema.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../../lib/workflow-caller.js";
import {
  auditTransitionRoleChanges,
  auditTransitionConditionChanges,
} from "../../../lib/audit-workflow-access.js";

const UpdateTransitionSchema = z.object({
  label: z.string().max(200).nullable().optional(),
  allowedRoles: z.array(z.string()).optional(),
  conditions: TransitionConditionsSchema.nullable().optional(),
  requiresComment: z.boolean().optional(),
  requiresFields: z.array(z.string()).optional(),
});

export const updateTransitionHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", UpdateTransitionSchema),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const transitionId = c.req.param("transitionId") ?? "";
    const input = c.req.valid("json");
    const auth = c.get("auth");
    const { tenantId } = auth;
    try {
      const transition = await withTenantContext(tenantId, async (tx) => {
        const [before] =
          input.allowedRoles !== undefined || input.conditions !== undefined
            ? await tx
                .select({
                  allowedRoles: workflowTransitions.allowedRoles,
                  conditions: workflowTransitions.conditions,
                })
                .from(workflowTransitions)
                .where(
                  and(
                    eq(workflowTransitions.id, transitionId),
                    eq(workflowTransitions.workflowId, workflowId),
                    eq(workflowTransitions.tenantId, tenantId),
                  ),
                )
                .limit(1)
            : [];
        const updated = await updateWorkflowTransition(
          tx,
          tenantId,
          workflowId,
          transitionId,
          toWorkflowCaller(auth),
          {
            label: input.label ?? undefined,
            allowedRoles: input.allowedRoles,
            conditions: input.conditions,
            requiresComment: input.requiresComment,
            requiresFields: input.requiresFields,
          },
        );
        if (before) {
          await auditTransitionRoleChanges(tx, {
            tenantId,
            actorId: auth.userId,
            workflowId,
            changes: [
              {
                transitionId,
                fromState: updated.fromState,
                toState: updated.toState,
                before: before.allowedRoles,
                after: updated.allowedRoles,
              },
            ],
          });
        }
        if (before && input.conditions !== undefined) {
          await auditTransitionConditionChanges(tx, {
            tenantId,
            actorId: auth.userId,
            workflowId,
            changes: [
              {
                transitionId,
                fromState: updated.fromState,
                toState: updated.toState,
                before: before.conditions,
                after: updated.conditions,
              },
            ],
          });
        }
        return updated;
      });
      return c.json({ data: transition });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
