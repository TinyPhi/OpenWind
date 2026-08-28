import { requireAuth, requireActingPerson } from "@platform/auth";
import { withTenantContext, db } from "@platform/db";
import { getWorkflow, WorkflowError } from "@platform/workflow-engine";
import { listEntityFields } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { notFound } from "./not-found.js";

function isWorkflowNotFound(err: unknown): boolean {
  return err instanceof WorkflowError && err.code === "WORKFLOW_NOT_FOUND";
}

/**
 * GET /api/v1/workflows/:workflowId/fields — third-party API schema/describe
 * endpoint (docs/specs/third-party-api-workflow-fields-schema.md).
 *
 * Standard pattern (Jira createmeta, Zendesk ticket_fields, Salesforce
 * describe) -- lets a partner integration render an accurate create-ticket
 * form instead of discovering required fields via repeated 422 failures.
 *
 * Tenant-wide visibility, no per-ticket access check -- mirrors GET
 * /workflows itself (this is schema metadata, not ticket instance data).
 * Deliberately reuses listEntityFields verbatim (global + tenant-specific
 * union, sortOrder already applied) rather than a narrower query invented
 * for this endpoint (spec R1/R6/§V) -- and since that lookup reads straight
 * from the DB with no cache layer of its own, the response is always
 * current, with no separate staleness guarantee to maintain here.
 */
export const getThirdPartyWorkflowFieldsHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("read"),
  async (c) => {
    const workflowId = c.req.param("workflowId") ?? "";
    const { tenantId } = c.get("auth");
    const { userId: actingPersonId } = c.get("actingPerson");

    try {
      const { workflow, fields } = await withTenantContext(
        tenantId,
        async (tx) => {
          const workflow = await getWorkflow(tx, tenantId, workflowId, {
            userId: actingPersonId,
            isGlobalAdmin: false,
          });
          const fields = await listEntityFields(
            tx,
            tenantId,
            workflow.entityTypeId,
          );
          return { workflow, fields };
        },
      );

      return c.json({
        data: {
          workflowId: workflow.id,
          entityTypeId: workflow.entityTypeId,
          // isSystem is deliberately NOT surfaced here (and never gates
          // inclusion) -- it governs admin-side edit/delete protection on
          // the field's own definition, not whether the field accepts a
          // value on ticket creation (spec R3).
          fields: fields.map((field) => ({
            name: field.name,
            label: field.label,
            type: field.fieldType,
            required: field.isRequired,
            sensitivity: field.sensitivity,
            config: field.config,
          })),
        },
      });
    } catch (err) {
      if (isWorkflowNotFound(err)) {
        return notFound(c);
      }
      throw err;
    }
  },
);
