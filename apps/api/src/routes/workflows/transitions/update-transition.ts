import { zValidator } from "../../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { workflowTransitions, withTenantContext } from "@platform/db";
import { and, eq } from "drizzle-orm";
import {
  assertWorkflowOwned,
  updateWorkflowTransition,
} from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { TransitionConditionsSchema } from "./condition-schema.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";
import {
  assertMayEditRuledWorkflow,
  assertMaySetActorRules,
  SodRuleForbiddenError,
} from "../../../lib/sod-rule-gate.js";
import { toWorkflowCaller } from "../../../lib/workflow-caller.js";
import {
  auditTransitionRoleChanges,
  auditTransitionConditionChanges,
  sameJson,
  sameMembers,
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
        const caller = toWorkflowCaller(auth);
        const editsAccess =
          input.allowedRoles !== undefined || input.conditions !== undefined;
        let workflowRows: Array<{
          id: string;
          allowedRoles: string[];
          conditions: unknown;
        }> = [];
        if (editsAccess) {
          // Ownership first, so a caller who does not administer the workflow gets 404 whatever the
          // stored rule state.
          await assertWorkflowOwned(tx, tenantId, workflowId, caller);
          workflowRows = await tx
            .select({
              id: workflowTransitions.id,
              allowedRoles: workflowTransitions.allowedRoles,
              conditions: workflowTransitions.conditions,
            })
            .from(workflowTransitions)
            .where(
              and(
                eq(workflowTransitions.workflowId, workflowId),
                eq(workflowTransitions.tenantId, tenantId),
              ),
            );
        }
        const before = workflowRows.find((r) => r.id === transitionId);
        if (before) {
          if (input.conditions !== undefined) {
            assertMaySetActorRules(
              auth,
              before.conditions ?? null,
              input.conditions,
            );
            if (!sameJson(before.conditions ?? null, input.conditions)) {
              assertMayEditRuledWorkflow(
                auth,
                workflowRows,
                "change transition conditions",
              );
            }
          }
          if (
            input.allowedRoles !== undefined &&
            !sameMembers(before.allowedRoles, input.allowedRoles)
          ) {
            assertMayEditRuledWorkflow(
              auth,
              workflowRows,
              "change allowed roles",
            );
          }
        }
        const updated = await updateWorkflowTransition(
          tx,
          tenantId,
          workflowId,
          transitionId,
          caller,
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
      if (err instanceof SodRuleForbiddenError) {
        return c.json({ error: "FORBIDDEN", message: err.message }, 403);
      }
      return handleWorkflowError(c, err);
    }
  },
);
