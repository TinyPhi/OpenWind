import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { requireAuth, requireActingPerson } from "@platform/auth";
import { withTenantContext, db, entityInstances } from "@platform/db";
import { createChildRelation, EntityError } from "@platform/entity-engine";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { hasEntityAccess } from "../../lib/entity-access.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { validateFieldsPayload } from "./validate-fields-payload.js";
import { notFound } from "./not-found.js";
import { withIdempotency } from "../../lib/idempotency.js";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";
import { applicationActorIdFromUserId } from "../../lib/application-actor-id.js";
import { redactEntityFieldsForThirdParty } from "../../lib/redact-entity-fields.js";
import { stripInternalFields } from "../../lib/strip-internal-fields.js";

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
 * Enforced via createChildRelation's maxAncestorDepth param, checked under
 * the same row lock as everything else it validates — a separate, unlocked
 * pre-check here would race against a concurrent moveChildRelation call
 * that reparents the target between this check and the actual create.
 */
export const createThirdPartyChildHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("subticket"),
  zValidator("json", CreateThirdPartyChildSchema),
  async (c) => {
    const parentId = c.req.param("id") ?? "";
    const { tenantId, userId: authUserId } = c.get("auth");
    const { userId: actingPersonId } = c.get("actingPerson");
    const input = c.req.valid("json");
    const applicationActorId = applicationActorIdFromUserId(authUserId);
    const idempotencyKey = c.req.header("Idempotency-Key");

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

    // deletedAt filtered out here (unlike a plain existence check) so a
    // soft-deleted parent 404s at this route the same way getEntity already
    // does for the sibling GET route — otherwise it would pass this access
    // check, then fail inside createChildRelation's own re-fetch with a
    // differently-shaped error, reopening the existence-oracle leak the
    // design doc's Round 2 finding required closed.
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
            isNull(entityInstances.deletedAt),
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
      // Best-effort: nothing has mutated yet on this path, so a failure here
      // must never turn a correct 404 denial into a 500 -- same pattern as
      // transitions.ts's denied-branch audit write.
      try {
        await withTenantContext(tenantId, (tx) =>
          writeAuditEntry(tx, {
            tenantId,
            actorId: applicationActorId,
            actorType: "api_key",
            actingPersonId,
            resourceType: "ticket",
            resourceId: parentId,
            action: "child.access_denied",
          }),
        );
      } catch (auditErr) {
        logger.warn(
          { auditErr, tenantId, parentId },
          "third-party sub-ticket create: denied-attempt audit write failed",
        );
      }
      return notFound(c);
    }

    const response = await withIdempotency(
      {
        tenantId,
        applicationActorId,
        actingPersonId,
        idempotencyKey,
      },
      {
        parentId,
        entityTypeId: input.entityTypeId,
        fields: input.fields,
        assignedTo: input.assignedTo ?? null,
      },
      async () => {
        try {
          const result = await withTenantContext(tenantId, async (tx) => {
            const created = await createChildRelation(tx, tenantId, {
              parentId,
              entityTypeId: input.entityTypeId,
              childFields: input.fields,
              assignedTo: input.assignedTo,
              createdBy: actingPersonId,
              actorType: "api_key",
              actingPersonId,
              maxAncestorDepth: 1,
            });
            await writeAuditEntry(tx, {
              tenantId,
              actorId: applicationActorId,
              actorType: "api_key",
              actingPersonId,
              resourceType: "ticket",
              resourceId: created.instance.id,
              action: "child.created",
              metadata: { parentId },
            });
            // ADR-012 Phase G, spec R7 -- same redact-then-strip pass the
            // GET routes apply, so a create response is never a second,
            // unfiltered path to the same ticket data (pii/financial values,
            // and the internal __accessUsers ACL object createChildRelation
            // always seeds from the parent's grants + assignee).
            const redactedFields = await redactEntityFieldsForThirdParty(
              tx,
              tenantId,
              created.instance.entityTypeId,
              created.instance.fields,
            );
            return {
              ...created,
              instance: {
                ...created.instance,
                fields: stripInternalFields(redactedFields),
              },
            };
          });
          return { status: 201, body: { data: result.instance } };
        } catch (err) {
          if (
            err instanceof EntityError &&
            err.code === "CHILD_DEPTH_EXCEEDED" &&
            err.meta?.reason === "caller_max_ancestor_depth"
          ) {
            return {
              status: 400,
              body: {
                error: "SUBTICKET_NESTING_EXCEEDED",
                message:
                  "An API-created sub-ticket cannot itself have a sub-ticket created via this API",
              },
            };
          }
          const errResponse = handleEntityError(c, err);
          return {
            status: errResponse.status,
            body: (await errResponse.json()) as unknown,
          };
        }
      },
    );

    return c.json(response.body as object, response.status as never);
  },
);
