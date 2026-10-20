import { requireAuth, requireRole } from "@platform/auth";
import { workflowTransitions, withTenantContext } from "@platform/db";
import { and, eq } from "drizzle-orm";
import { deleteWorkflowTransition } from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";
import {
  assertMaySetActorRules,
  SodRuleForbiddenError,
} from "../../../lib/sod-rule-gate.js";
import { toWorkflowCaller } from "../../../lib/workflow-caller.js";
import {
  auditTransitionRoleChanges,
  auditTransitionConditionChanges,
} from "../../../lib/audit-workflow-access.js";

export const deleteTransitionHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const transitionId = c.req.param("transitionId") ?? "";
    const auth = c.get("auth");
    const { tenantId } = auth;
    try {
      await withTenantContext(tenantId, async (tx) => {
        const [before] = await tx
          .select({
            fromState: workflowTransitions.fromState,
            toState: workflowTransitions.toState,
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
          .limit(1);
        if (before) assertMaySetActorRules(auth, before.conditions, null);
        await deleteWorkflowTransition(
          tx,
          tenantId,
          workflowId,
          transitionId,
          toWorkflowCaller(auth),
        );
        if (before) {
          await auditTransitionRoleChanges(tx, {
            tenantId,
            actorId: auth.userId,
            workflowId,
            changes: [
              {
                transitionId,
                fromState: before.fromState,
                toState: before.toState,
                before: before.allowedRoles,
                after: null,
              },
            ],
          });
          await auditTransitionConditionChanges(tx, {
            tenantId,
            actorId: auth.userId,
            workflowId,
            changes: [
              {
                transitionId,
                fromState: before.fromState,
                toState: before.toState,
                before: before.conditions,
                after: null,
              },
            ],
          });
        }
      });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof SodRuleForbiddenError) {
        return c.json({ error: "FORBIDDEN", message: err.message }, 403);
      }
      return handleWorkflowError(c, err);
    }
  },
);
