import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { requireAuth, requireActingPerson } from "@platform/auth";
import { withTenantContext, db, entityInstances } from "@platform/db";
import { getEntity, EntityError } from "@platform/entity-engine";
import { executeTransition, WorkflowError } from "@platform/workflow-engine";
import type { TransitionRequest } from "@platform/workflow-engine";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { hasTransitionAccess } from "../../lib/transition-access.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";
import { withIdempotency } from "../../lib/idempotency.js";
import { applicationActorIdFromUserId } from "../../lib/application-actor-id.js";

function isEntityNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === "EntityError" &&
    (err as Error & { code?: string }).code === "ENTITY_NOT_FOUND"
  );
}

// Same body as the access-denied branch below and every other third-party
// route's existence-oracle guard (security.md's 404-not-403 convention) —
// nonexistent, cross-tenant, and access-denied must all be indistinguishable.
function notFound(c: {
  json: (body: unknown, status: 404) => Response;
}): Response {
  return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
}

// Errors that would otherwise reveal something about a ticket/transition's
// existence beyond what our own access gate already confirmed — folded into
// the identical notFound() body instead of handleWorkflowError's differently
// shaped ones. Every other status handleWorkflowError returns (403 from the
// engine's own actorRoles check, 409 lock/conflict/not-available, 422
// condition/required-fields, 500 SLA-scheduling) only fires after this
// route's own creator/assignee/admin gate already passed, so it never leaks
// existence to a caller who wasn't already confirmed to have access.
const EXISTENCE_REVEALING_CODES = new Set([
  "WORKFLOW_NOT_FOUND",
  "INSTANCE_NOT_FOUND",
  "WORKFLOW_STATE_NOT_FOUND",
  "WORKFLOW_TRANSITION_NOT_FOUND",
]);

function isExistenceRevealingWorkflowError(err: unknown): boolean {
  return (
    err instanceof WorkflowError && EXISTENCE_REVEALING_CODES.has(err.code)
  );
}

// eslint-disable-next-line no-control-regex -- intentional: this IS the control-character check.
const FORBIDDEN_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

// The ONLY role a third-party caller may ever be granted for a transition
// (docs/specs/third-party-transition-role-mapping.md R1/§V). Typed `as const`
// so accidentally widening this to include "admin"/"agent" -- e.g. someone
// "being more permissive" for a special case -- is a visible, reviewable
// diff on this one line rather than a silent behavioral change buried in the
// request-building code below. workflow-engine does not export a named
// constant for its own role strings (they're opaque caller-supplied
// strings, not an enum), so this is defined locally rather than imported.
const THIRD_PARTY_BASELINE_ACTOR_ROLES = ["user"] as const;

const ExecuteThirdPartyTransitionSchema = z.object({
  transitionId: z.string().uuid(),
  comment: z
    .string()
    .min(1)
    .max(4000)
    .refine((v) => !FORBIDDEN_CHAR_PATTERN.test(v), {
      message: "comment contains a null byte or control character",
    })
    .optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * POST /api/v1/tickets/:id/transitions — ADR-012 Phase E, spec R1/R2/R3/R5.
 *
 * Access is creator/assignee/workflow-admin ONLY (hasTransitionAccess) —
 * deliberately narrower than every other third-party route's hasEntityAccess,
 * which also accepts any __accessUsers grant. A granted/mentioned identity,
 * even at read_write tier, is rejected here regardless of what it's allowed
 * to do on comments/reads (spec R2, resolved 2026-08-14 as an intentional
 * design boundary).
 *
 * executeTransition itself is called completely unmodified — no parallel or
 * shortcut validation path — so an invalid/skip-ahead transition gets
 * exactly the same rejection a human caller would (spec R1). actorRoles is
 * passed as ["user"] once hasTransitionAccess has already confirmed the
 * caller is a creator/assignee/workflow-admin -- every seeded workflow's
 * transitions require at least the baseline "user" role, so passing []
 * here made every role-restricted transition unreachable via the API even
 * for callers with genuine ticket-level access (found during Phase 4 E2E
 * testing). This never grants "admin"/"agent" -- a transition restricted to
 * those still 403s for a third-party caller, same as it would for any
 * internal user without that elevated role.
 */
export const executeThirdPartyTransitionHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("transition"),
  zValidator("json", ExecuteThirdPartyTransitionSchema),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId, userId: authUserId } = c.get("auth");
    const { userId: actingPersonId } = c.get("actingPerson");
    // `idempotencyKey` here is the pre-existing, narrower body field that
    // feeds workflow-engine's own event-dedup column
    // (workflow_events.idempotency_key) -- distinct from ADR-012 Phase G's
    // `Idempotency-Key` HTTP header handled below (apps/api/src/lib/
    // idempotency.ts), which caches the whole HTTP response.
    const { transitionId, comment, idempotencyKey, metadata } =
      c.req.valid("json");
    const applicationActorId = applicationActorIdFromUserId(authUserId);
    const idempotencyHeaderKey = c.req.header("Idempotency-Key");

    let instance;
    try {
      instance = await withTenantContext(tenantId, (tx) =>
        getEntity(tx, tenantId, instanceId),
      );
    } catch (err) {
      if (isEntityNotFound(err)) {
        return notFound(c);
      }
      throw err;
    }

    const allowed = await withTenantContext(tenantId, (tx) =>
      hasTransitionAccess(tx, tenantId, instance, actingPersonId),
    );
    if (!allowed) {
      // Best-effort: nothing has mutated yet on this path, so a failure here
      // must never turn a correct 404 denial into a 500 — logged and
      // swallowed rather than awaited into the response.
      try {
        await withTenantContext(tenantId, (tx) =>
          writeAuditEntry(tx, {
            tenantId,
            actorId: applicationActorId,
            actorType: "api_key",
            actingPersonId,
            resourceType: "ticket",
            resourceId: instanceId,
            action: "transition.access_denied",
            metadata: { transitionId },
          }),
        );
      } catch (auditErr) {
        logger.warn(
          { auditErr, tenantId, instanceId, transitionId },
          "third-party transition: denied-attempt audit write failed",
        );
      }
      return notFound(c);
    }

    const response = await withIdempotency(
      {
        tenantId,
        applicationActorId,
        actingPersonId,
        idempotencyKey: idempotencyHeaderKey,
      },
      {
        instanceId,
        transitionId,
        comment: comment ?? null,
        metadata: metadata ?? null,
      },
      async () => {
        try {
          const request: TransitionRequest = {
            instanceId,
            transitionId,
            actorId: actingPersonId,
            // Baseline "user" role only, granted here because
            // hasTransitionAccess (above) already confirmed creator/
            // assignee/workflow-admin access -- see module doc comment.
            actorRoles: [...THIRD_PARTY_BASELINE_ACTOR_ROLES],
            triggeredBy: "api",
            ...(comment !== undefined && { comment }),
            ...(idempotencyKey !== undefined && { idempotencyKey }),
            ...(metadata !== undefined && { metadata }),
          };

          const event = await withTenantContext(tenantId, async (tx) => {
            // T0. Lock the row immediately to prevent concurrent modification/TOCTOU
            const [lockedInstance] = await tx
              .select()
              .from(entityInstances)
              .where(
                and(
                  eq(entityInstances.id, instanceId),
                  eq(entityInstances.tenantId, tenantId),
                  isNull(entityInstances.deletedAt),
                ),
              )
              .for("update", { noWait: true })
              .limit(1);

            if (!lockedInstance) {
              throw new EntityError("ENTITY_NOT_FOUND", { instanceId });
            }

            const result = await executeTransition(tx, tenantId, request);
            await writeAuditEntry(tx, {
              tenantId,
              actorId: applicationActorId,
              actorType: "api_key",
              actingPersonId,
              resourceType: "ticket",
              resourceId: instanceId,
              action: "transition.executed",
              metadata: { transitionId, eventId: result.id },
            });
            return result;
          });

          return { status: 201, body: { data: event } };
        } catch (err) {
          const pgCode =
            (err as { code?: unknown }).code ??
            (err as { cause?: { code?: unknown } }).cause?.code;
          if (pgCode === "55P03") {
            const lockErr = new WorkflowError("TRANSITION_LOCKED", {
              instanceId,
            });
            const errResponse = handleWorkflowError(c, lockErr);
            const headers: Record<string, string> = {};
            errResponse.headers.forEach((value, key) => {
              headers[key] = value;
            });
            return {
              status: errResponse.status,
              body: (await errResponse.json()) as unknown,
              headers,
            };
          }

          if (isEntityNotFound(err) || isExistenceRevealingWorkflowError(err)) {
            return {
              status: 404,
              body: { error: "NOT_FOUND", message: "Record not found" },
            };
          }
          const errResponse = handleWorkflowError(c, err);
          return {
            status: errResponse.status,
            body: (await errResponse.json()) as unknown,
          };
        }
      },
    );

    if (response.headers) {
      for (const [key, value] of Object.entries(response.headers)) {
        c.header(key, value);
      }
    }

    return c.json(response.body as object, response.status as never);
  },
);
