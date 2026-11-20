import { zValidator } from "../../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { workflowTransitions, withTenantContext } from "@platform/db";
import { and, eq } from "drizzle-orm";
import {
  addWorkflowTransition,
  assertWorkflowOwned,
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
} from "../../../lib/audit-workflow-access.js";

const CreateTransitionSchema = z.object({
  fromState: z.string().min(1).max(100),
  toState: z.string().min(1).max(100),
  label: z.string().max(200).optional(),
  allowedRoles: z.array(z.string()).optional(),
  conditions: TransitionConditionsSchema.nullable().optional(),
  requiresComment: z.boolean().optional(),
  requiresFields: z.array(z.string()).optional(),
});

export const createTransitionHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateTransitionSchema),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const auth = c.get("auth");
    const { tenantId } = auth;
    try {
      const transition = await withTenantContext(tenantId, async (tx) => {
        // Ownership first: a caller who does not administer the workflow gets the same 404 whatever
        // the stored rule state, so the response never depends on a workflow they cannot manage.
        const caller = toWorkflowCaller(auth);
        await assertWorkflowOwned(tx, tenantId, workflowId, caller);
        const workflowTransitionRows = await tx
          .select({ conditions: workflowTransitions.conditions })
          .from(workflowTransitions)
          .where(
            and(
              eq(workflowTransitions.workflowId, workflowId),
              eq(workflowTransitions.tenantId, tenantId),
            ),
          );
        assertMaySetActorRules(auth, null, input.conditions ?? null);
        assertMayEditRuledWorkflow(
          auth,
          workflowTransitionRows,
          "add a transition",
        );
        const created = await addWorkflowTransition(
          tx,
          tenantId,
          workflowId,
          caller,
          {
            fromState: input.fromState,
            toState: input.toState,
            label: input.label,
            allowedRoles: input.allowedRoles,
            conditions: input.conditions,
            requiresComment: input.requiresComment,
            requiresFields: input.requiresFields,
          },
        );
        await auditTransitionRoleChanges(tx, {
          tenantId,
          actorId: auth.userId,
          workflowId,
          changes: [
            {
              transitionId: created.id,
              fromState: created.fromState,
              toState: created.toState,
              before: null,
              after: created.allowedRoles,
            },
          ],
        });
        await auditTransitionConditionChanges(tx, {
          tenantId,
          actorId: auth.userId,
          workflowId,
          changes: [
            {
              transitionId: created.id,
              fromState: created.fromState,
              toState: created.toState,
              before: null,
              after: created.conditions,
            },
          ],
        });
        return created;
      });
      return c.json({ data: transition }, 201);
    } catch (err) {
      if (err instanceof SodRuleForbiddenError) {
        return c.json({ error: "FORBIDDEN", message: err.message }, 403);
      }
      return handleWorkflowError(c, err);
    }
  },
);
