import { requireAuth, requireRole } from "@platform/auth";
import { entityInstances, withTenantContext } from "@platform/db";
import { eq, and, or, sql } from "drizzle-orm";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { hasEntityReadAccess } from "../../lib/entity-access.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";

// A workflow's states/transitions/SLA config is not public within the tenant —
// undoing the previous admin-or-assignee check (commit dc2bb0c, "H2") let any
// "user"-role caller browse any workflow's full definition by ID. Restoring
// that check as isWorkflowAdmin (createdBy or assignedTo) preserves the
// legitimate case record-detail.tsx relies on: a ticket viewer without
// workflow-admin status still needs to read *their own ticket's* workflow for
// states/transitions, so an optional ?entityId= proves that — caller must
// have read access to that entity AND the entity's workflowId must match.
//
// The kanban board (workflow-records.tsx) has no single entityId to prove —
// it renders the whole board of records the caller can see. Without a
// fallback, any plain "user"/"agent" caller who isn't a workflow admin got a
// 404 fetching the board's own workflow definition, even though they legitimately
// own tickets in it. Fall back to the same three-vector check my-tickets.ts
// uses (created_by / assigned_to / __accessUsers ACL key) against ANY instance
// in this workflow — proves the caller has a real stake in the workflow
// without requiring them to name one specific record up front.
export const getWorkflowHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const auth = c.get("auth");
    const { tenantId, userId, roles } = auth;
    const entityId = c.req.query("entityId");
    try {
      const workflow = await withTenantContext(tenantId, (tx) =>
        getWorkflow(tx, tenantId, id, toWorkflowCaller(auth)),
      );

      const isGlobalAdmin = roles.includes("admin");
      let authorized = isGlobalAdmin || isWorkflowAdmin(userId, workflow);

      if (!authorized && entityId) {
        const [instance] = await withTenantContext(tenantId, (tx) =>
          tx
            .select({
              createdBy: entityInstances.createdBy,
              assignedTo: entityInstances.assignedTo,
              fields: entityInstances.fields,
              workflowId: entityInstances.workflowId,
            })
            .from(entityInstances)
            .where(
              and(
                eq(entityInstances.id, entityId),
                eq(entityInstances.tenantId, tenantId),
              ),
            )
            .limit(1),
        );
        authorized =
          instance?.workflowId === id &&
          hasEntityReadAccess(instance, userId, roles);
      }

      if (!authorized) {
        const [own] = await withTenantContext(tenantId, (tx) =>
          tx
            .select({ id: entityInstances.id })
            .from(entityInstances)
            .where(
              and(
                eq(entityInstances.workflowId, id),
                eq(entityInstances.tenantId, tenantId),
                or(
                  eq(entityInstances.createdBy, userId),
                  eq(entityInstances.assignedTo, userId),
                  sql`${entityInstances.fields}->'__accessUsers' ? ${userId}`,
                ),
              ),
            )
            .limit(1),
        );
        authorized = !!own;
      }

      if (!authorized) {
        return c.json(
          { error: "WORKFLOW_NOT_FOUND", message: "Workflow not found" },
          404,
        );
      }

      return c.json({ data: workflow });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
