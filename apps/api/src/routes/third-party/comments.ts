import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireActingPerson } from "@platform/auth";
import {
  withTenantContext,
  db,
  entityInstances,
  workflowEvents,
  outboxEvents,
} from "@platform/db";
import { logger } from "@platform/logger";
import { writeAuditEntry } from "@platform/audit";
import { applicationActorIdFromUserId } from "../../lib/application-actor-id.js";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { hasEntityCommentAccessFull } from "../../lib/entity-access.js";
import { mentionResolutionQueue } from "../../lib/mention-resolution-queue.js";
import {
  referenceAttachments,
  AttachmentReferenceError,
  MAX_ATTACHMENTS_PER_TICKET,
} from "./attachments-reference.js";
import { notFound } from "./not-found.js";
import { withIdempotency } from "../../lib/idempotency.js";

// Same forbidden-char set as validate-fields-payload.ts (ADR-012 Phase B,
// R11) — null byte/control-character rejection at ingress, ahead of any
// downstream rendering. Tab/LF/CR (0x09/0x0A/0x0D) are legitimate in
// free-text comment bodies.
// eslint-disable-next-line no-control-regex -- intentional: this IS the control-character check.
const FORBIDDEN_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

const CreateThirdPartyCommentSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(4000)
    .refine((v) => !FORBIDDEN_CHAR_PATTERN.test(v), {
      message: "text contains a null byte or control character",
    }),
  // Stable identifiers only (email or Zitadel org user ID) — never a display
  // name (spec R4). Resolution happens fully async, after this response is
  // already sent (spec R5/R6) — see mention-resolution-worker.ts.
  mentions: z.array(z.string().min(1)).max(20).default([]),
  // ADR-012 Phase D, spec R3 -- references completed attachment uploads;
  // never file content itself (spec R2, see attachments-presign.ts).
  attachmentIds: z
    .array(z.string().uuid())
    .max(MAX_ATTACHMENTS_PER_TICKET)
    .default([]),
});

/**
 * POST /api/v1/tickets/:id/comments — ADR-012 Phase C, spec R1/R2/R3.
 *
 * Access-gated via hasEntityCommentAccessFull — the same helper add-comment.ts
 * (the human-UI route) now uses, extracted specifically so this endpoint
 * doesn't duplicate that ACL logic (spec R2, closes enablement-phases gap
 * #2). Always 404 on denial, same convention as Phase B's ticket-detail
 * route (no distinguishable access-denied response).
 *
 * The acting person has no internal RBAC role in this system (same rationale
 * as tickets.ts's third-party handlers) — passing an empty roles array means
 * hasEntityCommentAccessFull's admin/agent bypass never fires, and access
 * reduces purely to ownership/__accessUsers level/workflow-admin status.
 */
export const createThirdPartyCommentHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("comment"),
  zValidator("json", CreateThirdPartyCommentSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, orgId, userId: authUserId } = c.get("auth");
    const { userId: actingPersonId } = c.get("actingPerson");
    const { text, mentions, attachmentIds } = c.req.valid("json");
    const applicationActorId = applicationActorIdFromUserId(authUserId);
    const idempotencyKey = c.req.header("Idempotency-Key");

    const [instance] = await withTenantContext(tenantId, (tx) =>
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
            eq(entityInstances.id, id),
            eq(entityInstances.tenantId, tenantId),
          ),
        )
        .limit(1),
    );

    if (!instance?.workflowId) {
      return notFound(c);
    }
    const workflowId = instance.workflowId;

    // hasEntityCommentAccessFull does an internal getWorkflow lookup, which
    // can throw WORKFLOW_NOT_FOUND if the workflow is deleted between the
    // instance fetch above and this call (#184, same race add-comment.ts
    // handles). Caught here and folded into the same notFound() every other
    // denial on this route returns — this route's own isolation tests assert
    // an identical 404 body regardless of cause, stricter than
    // handleEntityError's differently-shaped WORKFLOW_NOT_FOUND body.
    let allowed: boolean;
    try {
      allowed = await withTenantContext(tenantId, (tx) =>
        hasEntityCommentAccessFull(tx, tenantId, instance, actingPersonId, []),
      );
    } catch {
      return notFound(c);
    }
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
            resourceId: id,
            action: "comment.access_denied",
          }),
        );
      } catch (auditErr) {
        logger.warn(
          { auditErr, tenantId, instanceId: id },
          "third-party comment: denied-attempt audit write failed",
        );
      }
      return notFound(c);
    }

    // ADR-012 Phase G, spec R3/R4/R5 -- everything from here down (attachment
    // binding, the comment insert + its audit entry, the outbox write,
    // mention enqueue) is the actual mutating action idempotency protects. A
    // cache-hit replay skips all of it, including the fire-and-forget side
    // effects and the audit write, since they already ran on the original
    // request.
    const response = await withIdempotency(
      {
        tenantId,
        applicationActorId,
        actingPersonId,
        idempotencyKey,
      },
      { ticketId: id, text, mentions, attachmentIds },
      async () => {
        // Validate + bind attachment references BEFORE creating the comment
        // (spec R3) -- a rejected reference must never leave an orphaned
        // comment behind. This runs in its own transaction, separate from the
        // comment insert below (unlike tickets.ts, which shares one transaction
        // with createEntity) -- if the bind succeeds here but the insert below
        // fails for an unrelated reason, the attachment stays bound with no
        // comment referencing it. Accepted: the attachment is still
        // tenant/ticket-scoped and access-gated identically either way, and the
        // idempotent-re-reference path (see attachments-reference.ts) lets a
        // retried request safely re-bind to the same ticket.
        try {
          await withTenantContext(tenantId, (tx) =>
            referenceAttachments(
              tx,
              tenantId,
              id,
              attachmentIds,
              actingPersonId,
              applicationActorId,
            ),
          );
        } catch (err) {
          if (err instanceof AttachmentReferenceError) {
            return { status: err.status, body: err.body };
          }
          throw err;
        }

        // actorType/actingPersonId in metadata (not a dedicated column —
        // workflow_events has no actor-type/acting-person columns, unlike
        // admin_audit_log's Phase B additions) is what makes this comment
        // attributable to app+person for the ticket timeline (spec R10); the
        // timeline UI's own app-tag/person-name rendering is T7a, not this task.
        const [event] = await withTenantContext(tenantId, async (tx) => {
          const [inserted] = await tx
            .insert(workflowEvents)
            .values({
              tenantId,
              instanceId: id,
              workflowId,
              fromState: instance.currentState,
              toState: instance.currentState,
              triggeredBy: "api_key",
              actorId: actingPersonId,
              comment: null,
              metadata: {
                type: "comment",
                text,
                actorType: "api_key",
                actingPersonId,
              },
            })
            .returning();
          if (inserted) {
            await writeAuditEntry(tx, {
              tenantId,
              actorId: applicationActorId,
              actorType: "api_key",
              actingPersonId,
              resourceType: "ticket",
              resourceId: id,
              action: "comment.created",
              metadata: { eventId: inserted.id },
            });
          }
          return [inserted];
        });

        if (!event) {
          return {
            status: 500,
            body: {
              error: "INTERNAL_ERROR",
              message: "Failed to record comment",
            },
          };
        }

        // Fires for every comment, same as add-comment.ts's own comment.created
        // write -- feeds the ticket-room WS live-push path and comment-triggered
        // automations. Without this, a third-party-posted comment silently never
        // reaches either. Fire-and-forget: an outbox write failure must never
        // turn an already-successful comment creation into an error response.
        try {
          await withTenantContext(tenantId, (tx) =>
            tx.insert(outboxEvents).values({
              tenantId,
              eventType: "comment.created",
              version: 1,
              payload: {
                eventType: "comment.created",
                version: 1,
                tenantId,
                instanceId: id,
                actorId: actingPersonId,
                commentId: event.id,
              },
            }),
          );
        } catch (outboxErr) {
          logger.warn(
            {
              outboxErr,
              tenantId,
              instanceId: id,
              eventType: "comment.created",
            },
            "third-party comment: outbox write failed — live push/automations missed, primary operation succeeded",
          );
        }

        // Enqueue-only, never awaited past the add — resolution must never add
        // latency to this response (spec R5/R6: the response has to be identical
        // and equally fast regardless of what any mention will resolve to, which
        // is only true if resolution happens strictly after this point). A queue
        // failure here is logged by BullMQ's own Redis-connection error handling
        // and does not fail the comment itself — the comment succeeded; only its
        // mentions would silently not resolve, which is an accepted trade-off of
        // the fire-and-forget enqueue (no synchronous confirmation is possible
        // without reintroducing the very latency this design avoids).
        for (const mentionIdentifier of mentions) {
          void mentionResolutionQueue.add("resolve", {
            tenantId,
            orgId: orgId ?? "",
            ticketId: id,
            workflowId,
            mentionIdentifier,
            actingPersonId,
            commentId: event.id,
          });
        }

        return { status: 201, body: { data: { id: event.id } } };
      },
    );

    return c.json(response.body as object, response.status as never);
  },
);
