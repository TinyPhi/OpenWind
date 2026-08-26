import { z } from "zod";
import { requireAuth, requireActingPerson } from "@platform/auth";
import { withTenantContext, db } from "@platform/db";
import { getEntity } from "@platform/entity-engine";
import { executeTransition, WorkflowError } from "@platform/workflow-engine";
import type { TransitionRequest } from "@platform/workflow-engine";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { hasTransitionAccess } from "../../lib/transition-access.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";
import { apiKeyIdFromUserId } from "../../lib/api-key-id.js";

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

const ExecuteThirdPartyTransitionSchema = z.object({
  transitionId: z.string().uuid(),
  comment: z.string().optional(),
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
 * passed as [] (the acting person has no internal RBAC role in this system,
 * same convention every other third-party route already uses), so a
 * transition with its own role-restricted guard is enforced identically for
 * API and human-roleless callers.
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
    const { transitionId, comment, idempotencyKey, metadata } =
      c.req.valid("json");
    const apiKeyId = apiKeyIdFromUserId(authUserId);

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
            actorId: apiKeyId,
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

    try {
      const request: TransitionRequest = {
        instanceId,
        transitionId,
        actorId: actingPersonId,
        actorRoles: [],
        triggeredBy: "api",
        ...(comment !== undefined && { comment }),
        ...(idempotencyKey !== undefined && { idempotencyKey }),
        ...(metadata !== undefined && { metadata }),
      };

      // executeTransition and its audit entry share the SAME transaction
      // (security-reviewer finding) -- writeAuditEntry's own module doc
      // requires this ("call inside the same transaction as the entity
      // mutation"). Splitting them into separate withTenantContext calls
      // would let the transition commit and then the audit write fail
      // independently, producing a repudiation gap (a real state change
      // with zero audit trail) and a misleading 500 for a request that
      // actually succeeded.
      const event = await withTenantContext(tenantId, async (tx) => {
        const result = await executeTransition(tx, tenantId, request);
        await writeAuditEntry(tx, {
          tenantId,
          actorId: apiKeyId,
          actorType: "api_key",
          actingPersonId,
          resourceType: "ticket",
          resourceId: instanceId,
          action: "transition.executed",
          metadata: { transitionId, eventId: result.id },
        });
        return result;
      });

      return c.json({ data: event }, 201);
    } catch (err) {
      if (isExistenceRevealingWorkflowError(err)) {
        return notFound(c);
      }
      return handleWorkflowError(c, err);
    }
  },
);
