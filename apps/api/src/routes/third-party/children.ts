import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireActingPerson } from "@platform/auth";
import { withTenantContext, db, entityInstances } from "@platform/db";
import { createChildRelation, getAncestorDepth } from "@platform/entity-engine";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { hasEntityAccess } from "../../lib/entity-access.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { validateFieldsPayload } from "./validate-fields-payload.js";

function notFound(c: {
  json: (body: unknown, status: 404) => Response;
}): Response {
  return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
}

const CreateThirdPartyChildSchema = z.object({
  entityTypeId: z.string().uuid(),
  fields: z.record(z.unknown()).default({}),
  assignedTo: z.string().optional(),
  // No state/currentState field, same rationale as Phase B's ticket-create
  // schema (spec R6 pattern) — a sub-ticket is always created into its own
  // "open" child_status, never a caller-supplied value.
});

/**
 * POST /api/v1/tickets/:id/children — ADR-012 Phase C, spec R9.
 *
 * Access to the *parent* ticket is gated the same way ticket detail is
 * (hasEntityAccess — any recognized access level, not the stricter
 * comment-only tier comments.ts uses, since creating a sub-ticket is closer
 * to "I can see/work this ticket" than "I can specifically comment on it").
 * Always 404 on denial, same convention as the rest of this API.
 *
 * 1-level nesting cap (spec R9): if the target parent is itself already a
 * child (ancestorDepth >= 1) — regardless of whether that parent was created
 * via this API or the UI — a further child cannot be created through this
 * endpoint. This is an API-specific restriction layered on top of
 * createChildRelation's own general CHILD_DEPTH_EXCEEDED check (which is
 * keyed off the workflow's own, possibly deeper, max_child_depth setting).
 */
export const createThirdPartyChildHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("subticket"),
  zValidator("json", CreateThirdPartyChildSchema),
  async (c) => {
    const parentId = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");
    const { userId: actingPersonId } = c.get("actingPerson");
    const input = c.req.valid("json");

    const fieldsCheck = validateFieldsPayload(input.fields);
    if (!fieldsCheck.ok) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Validation failed",
          fields: { fields: fieldsCheck.reason },
        },
        422,
      );
    }

    const [parent] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          id: entityInstances.id,
          workflowId: entityInstances.workflowId,
          currentState: entityInstances.currentState,
          assignedTo: entityInstances.assignedTo,
          createdBy: entityInstances.createdBy,
          fields: entityInstances.fields,
        })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.id, parentId),
            eq(entityInstances.tenantId, tenantId),
          ),
        )
        .limit(1),
    );

    if (!parent) {
      return notFound(c);
    }

    const allowed = await withTenantContext(tenantId, (tx) =>
      hasEntityAccess(tx, tenantId, parent, actingPersonId, []),
    );
    if (!allowed) {
      return notFound(c);
    }

    try {
      const ancestorDepth = await withTenantContext(tenantId, (tx) =>
        getAncestorDepth(tx, tenantId, parentId),
      );
      if (ancestorDepth >= 1) {
        return c.json(
          {
            error: "SUBTICKET_NESTING_EXCEEDED",
            message:
              "An API-created sub-ticket cannot itself have a sub-ticket created via this API",
          },
          400,
        );
      }

      const result = await withTenantContext(tenantId, (tx) =>
        createChildRelation(tx, tenantId, {
          parentId,
          entityTypeId: input.entityTypeId,
          childFields: input.fields,
          assignedTo: input.assignedTo,
          createdBy: actingPersonId,
          actorType: "api_key",
          actingPersonId,
        }),
      );
      return c.json({ data: result.instance }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
