import { z } from "zod";
import { requireAuth, requireActingPerson } from "@platform/auth";
import { withTenantContext, db } from "@platform/db";
import { getEntity, createEntity } from "@platform/entity-engine";
import { getWorkflow } from "@platform/workflow-engine";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { forwardResponseHeaders } from "./utils.js";
import { hasEntityAccess } from "../../lib/entity-access.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { validateFieldsPayload } from "./validate-fields-payload.js";
import {
  referenceAttachments,
  AttachmentReferenceError,
  MAX_ATTACHMENTS_PER_TICKET,
} from "./attachments-reference.js";
import { notFound } from "./not-found.js";
import { redactEntityFieldsForThirdParty } from "../../lib/redact-entity-fields.js";
import { withIdempotency, isIdempotencyStatus } from "../../lib/idempotency.js";
import { applicationActorIdFromUserId } from "../../lib/application-actor-id.js";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";

function isEntityNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === "EntityError" &&
    (err as Error & { code?: string }).code === "ENTITY_NOT_FOUND"
  );
}

/**
 * GET /api/v1/tickets/:id — ADR-012 Phase B, spec R7.
 *
 * Access-list gated via the same shared hasEntityAccess helper the UI's own
 * entity-detail route (entities/get.ts) uses — not a re-implemented inline
 * check. Always 404 on denial, INCLUDING a cross-tenant ticket ID: getEntity
 * already applies an explicit `tenant_id = ?` filter (defense-in-depth
 * alongside entity_instances' own RLS), so a cross-tenant row throws the
 * exact same ENTITY_NOT_FOUND a genuinely nonexistent ID would — no separate
 * cross-tenant branch exists to add here, matching the platform's standard
 * 404-not-403 convention (security.md).
 *
 * The acting person has no internal RBAC role in this system (they never log
 * into OpenWind — that's the whole point of the third-party API) — passing
 * an empty roles array means hasEntityAccess's admin/agent bypass never
 * fires, and access reduces purely to the ACL fields (creator/assignee/
 * __accessUsers) or workflow-admin status, exactly the access-list model
 * the design doc's interview section specifies for this identity.
 */
export const getThirdPartyTicketHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("read"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId: authUserId } = c.get("auth");
    const { userId } = c.get("actingPerson");
    const applicationActorId = applicationActorIdFromUserId(authUserId);

    try {
      const instance = await withTenantContext(tenantId, (tx) =>
        getEntity(tx, tenantId, id),
      );

      const allowed = await withTenantContext(tenantId, (tx) =>
        hasEntityAccess(tx, tenantId, instance, userId, []),
      );
      if (!allowed) {
        // Best-effort: an audit-write failure must never turn a correct 404
        // denial into a 500 -- same pattern as transitions.ts's denied
        // branch.
        try {
          await withTenantContext(tenantId, (tx) =>
            writeAuditEntry(tx, {
              tenantId,
              actorId: applicationActorId,
              actorType: "api_key",
              actingPersonId: userId,
              resourceType: "ticket",
              resourceId: id,
              action: "ticket.view_denied",
            }),
          );
        } catch (auditErr) {
          logger.warn(
            { auditErr, tenantId, instanceId: id },
            "third-party ticket view: denied-attempt audit write failed",
          );
        }
        return notFound(c);
      }

      // ADR-012 Phase G, spec R7 — redact pii/financial field values before
      // this ever leaves the process; a third party never sees a raw,
      // unredacted dump of ticket fields.
      const redactedFields = await withTenantContext(tenantId, (tx) =>
        redactEntityFieldsForThirdParty(
          tx,
          tenantId,
          instance.entityTypeId,
          instance.fields,
        ),
      );

      // Best-effort, same rationale as the denied branch above -- a logging
      // hiccup must never turn a successful read into a 500.
      try {
        await withTenantContext(tenantId, (tx) =>
          writeAuditEntry(tx, {
            tenantId,
            actorId: applicationActorId,
            actorType: "api_key",
            actingPersonId: userId,
            resourceType: "ticket",
            resourceId: id,
            action: "ticket.viewed",
          }),
        );
      } catch (auditErr) {
        logger.warn(
          { auditErr, tenantId, instanceId: id },
          "third-party ticket view: allowed-attempt audit write failed",
        );
      }

      return c.json({ data: { ...instance, fields: redactedFields } });
    } catch (err) {
      if (isEntityNotFound(err)) {
        return notFound(c);
      }
      throw err;
    }
  },
);

const CreateThirdPartyTicketSchema = z.object({
  workflowId: z.string().uuid(),
  fields: z.record(z.unknown()).default({}),
  assignedTo: z.string().optional(),
  // Any `state`/`currentState` field the caller sends is intentionally NOT
  // part of this schema — Zod's default "strip unknown keys" behavior drops
  // it silently, with no rejection (spec R6: force-to-initial-state
  // unconditionally, confirmed decision, no error path for this case).
  // ADR-012 Phase D, spec R3 -- references completed attachment uploads
  // presigned without a ticketId (the create-time-attach case).
  attachmentIds: z
    .array(z.string().uuid())
    .max(MAX_ATTACHMENTS_PER_TICKET)
    .default([]),
});

/**
 * POST /api/v1/tickets — ADR-012 Phase B, spec R6/R8/R9/R11/R13/R14.
 *
 * Always creates into the workflow's initial state: createEntity is never
 * given a `currentState`, so it falls into entity-engine's own
 * resolve-initial-state branch (packages/entity-engine/src/engine.ts) —
 * there is no separate "force to initial" flag to maintain, and no way for
 * a caller-supplied state to reach the engine at all.
 *
 * Creator identity: actorType is explicitly "api_key" (not inferred as
 * "user" the way the human-UI route's createdBy-based heuristic would),
 * and actingPersonId carries the real person distinctly — resolves the
 * ambiguity flagged since the very first gap analysis (#3) and Round 7's
 * GAP-05. createdBy itself is also stamped with the acting person's id, so
 * the created record's own creator field shows the real person, not the
 * key.
 */
export const createThirdPartyTicketHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("create"),
  zValidator("json", CreateThirdPartyTicketSchema),
  async (c) => {
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

    // ADR-012 Phase G, spec R3/R4/R5 -- idempotency wraps only the actual
    // mutating operation, not upstream validation, so a caller retrying a
    // request that already 422'd above re-validates fresh rather than
    // replaying a cached failure forever under the same key.
    const response = await withIdempotency(
      {
        tenantId,
        applicationActorId,
        actingPersonId,
        idempotencyKey,
      },
      {
        workflowId: input.workflowId,
        fields: input.fields,
        assignedTo: input.assignedTo ?? null,
        attachmentIds: input.attachmentIds,
      },
      async () => {
        try {
          const instance = await withTenantContext(tenantId, async (tx) => {
            const workflow = await getWorkflow(tx, tenantId, input.workflowId, {
              userId: actingPersonId,
              isGlobalAdmin: false,
            });
            const created = await createEntity(tx, tenantId, {
              entityTypeId: workflow.entityTypeId,
              workflowId: workflow.id,
              fields: input.fields,
              assignedTo: input.assignedTo,
              createdBy: actingPersonId,
              actorId: applicationActorId,
              actorType: "api_key",
              actingPersonId,
            });
            // Same transaction as the create above -- a rejected attachment
            // reference rolls back the whole ticket creation, never leaving a
            // ticket with a dangling bad attachmentId (spec R3).
            await referenceAttachments(
              tx,
              tenantId,
              created.id,
              input.attachmentIds,
              actingPersonId,
              applicationActorId,
            );
            return created;
          });

          return { status: 201, body: { data: instance } };
        } catch (err) {
          if (err instanceof AttachmentReferenceError) {
            const status = isIdempotencyStatus(err.status) ? err.status : 500;
            return {
              status,
              body: err.body,
              doNotCache: status >= 500,
            };
          }
          const errResponse = handleEntityError(c, err);
          const status = isIdempotencyStatus(errResponse.status)
            ? errResponse.status
            : 500;
          return {
            status,
            body: (await errResponse.json()) as unknown,
            doNotCache: status >= 500,
          };
        }
      },
    );

    forwardResponseHeaders(c, response);

    return c.json(response.body as object, response.status);
  },
);
