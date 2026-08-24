import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireActingPerson } from "@platform/auth";
import {
  withTenantContext,
  db,
  entityInstances,
  workflowEvents,
} from "@platform/db";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { hasEntityCommentAccessFull } from "../../lib/entity-access.js";

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
  // Mentions/tag-resolution ship in Phase C's tagging PR (C2) — this schema
  // deliberately accepts comment text only for now (ADR-012 Phase C spec,
  // §T task T1b is scoped to comment posting, not tagging).
});

function notFound(c: {
  json: (body: unknown, status: 404) => Response;
}): Response {
  return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
}

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
    const { tenantId } = c.get("auth");
    const { userId: actingPersonId } = c.get("actingPerson");
    const { text } = c.req.valid("json");

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

    const allowed = await withTenantContext(tenantId, (tx) =>
      hasEntityCommentAccessFull(tx, tenantId, instance, actingPersonId, []),
    );
    if (!allowed) {
      return notFound(c);
    }

    // actorType/actingPersonId in metadata (not a dedicated column —
    // workflow_events has no actor-type/acting-person columns, unlike
    // admin_audit_log's Phase B additions) is what makes this comment
    // attributable to app+person for the ticket timeline (spec R10); the
    // timeline UI's own app-tag/person-name rendering is T7a, not this task.
    const [event] = await withTenantContext(tenantId, (tx) =>
      tx
        .insert(workflowEvents)
        .values({
          tenantId,
          instanceId: id,
          workflowId: instance.workflowId as string,
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
        .returning(),
    );

    if (!event) {
      return c.json(
        { error: "INTERNAL_ERROR", message: "Failed to record comment" },
        500,
      );
    }

    return c.json({ data: { id: event.id } }, 201);
  },
);
