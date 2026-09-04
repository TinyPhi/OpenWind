import { z } from "zod";
import { requireAuth, requireActingPerson } from "@platform/auth";
import { withTenantContext, db } from "@platform/db";
import { getWorkflow, WorkflowError } from "@platform/workflow-engine";
import { listEntityFields } from "@platform/entity-engine";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { notFound } from "./not-found.js";
import { applicationActorIdFromUserId } from "../../lib/application-actor-id.js";

function isWorkflowNotFound(err: unknown): boolean {
  return err instanceof WorkflowError && err.code === "WORKFLOW_NOT_FOUND";
}

const WorkflowIdSchema = z.string().uuid();

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
    const rawWorkflowId = c.req.param("workflowId");
    const { tenantId, userId: authUserId } = c.get("auth");
    const { userId: actingPersonId } = c.get("actingPerson");
    const applicationActorId = applicationActorIdFromUserId(authUserId);

    // A non-UUID path segment can never resolve to a real workflow row --
    // treat it the same as a genuinely nonexistent one (404, not a 500 from
    // Postgres rejecting the cast, and not a 422/400 that would distinguish
    // "malformed" from "doesn't exist" -- existence-oracle convention,
    // security.md).
    const parsed = WorkflowIdSchema.safeParse(rawWorkflowId);
    if (!parsed.success) {
      return notFound(c);
    }
    const workflowId = parsed.data;

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

      // Best-effort -- a logging hiccup must never turn a successful describe
      // call into a 500.
      try {
        await withTenantContext(tenantId, (tx) =>
          writeAuditEntry(tx, {
            tenantId,
            actorId: applicationActorId,
            actorType: "api_key",
            actingPersonId,
            resourceType: "workflow",
            resourceId: workflow.id,
            action: "workflow_fields.listed",
          }),
        );
      } catch (auditErr) {
        logger.warn(
          { auditErr, tenantId, workflowId: workflow.id },
          "third-party workflow fields: audit write failed",
        );
      }

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
            // Passed through raw and unvalidated. Safe today because
            // `config`'s shape per field type (options/min-max/currencies
            // etc.) never carries anything sensitive or internal-only --
            // but if a future field type's config ever grows a field that
            // shouldn't cross the third-party boundary, it needs an
            // explicit allow-list/strip step here, not an implicit "it's
            // always been fine" assumption.
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
