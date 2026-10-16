import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { writeAuditEntry } from "@platform/audit";
import { withTenantContext } from "@platform/db";
import { getEntity, getEntityType, EntityError } from "@platform/entity-engine";
import {
  overrideWorkflowState,
  OVERRIDE_REASON_MAX_LENGTH,
} from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

const OverrideStateSchema = z.object({
  state: z.string().min(1).max(100),
  // The engine enforces the minimum (so the message carries the real bounds); this caps the body.
  reason: z.string().max(OVERRIDE_REASON_MAX_LENGTH * 2),
});

/**
 * The recorded, reasoned way for an admin to move a record to a chosen step outside its
 * workflow's transitions (docs/specs/state-override.md). Admin only; the workflow must have
 * switched `allowStateOverride` on; the record's creator cannot use it on their own record.
 * The admin audit entry is written in the same transaction as the state change.
 *
 * Rate limit: the default per-tenant limiter applies and is deliberately not tightened. The
 * route is admin-only, needs a per-workflow switch and a reason, and every call is audited.
 */
export const overrideStateHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("json", OverrideStateSchema),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const { state, reason } = c.req.valid("json");

    try {
      // One transaction for the lot: the access check, the override and the audit entry all see
      // the same record under the same lock, so access cannot change between the check and the
      // change, and a failed audit write rolls the state change back with it.
      const event = await withTenantContext(tenantId, async (tx) => {
        const instance = await getEntity(tx, tenantId, instanceId);
        if (!(await hasEntityAccess(tx, tenantId, instance, userId, roles))) {
          return null;
        }

        const result = await overrideWorkflowState(tx, tenantId, {
          instanceId,
          state,
          reason,
          actorId: userId,
          actorRoles: roles,
        });
        // Labelled with the entity type's name, like the entity engine's own audit entries, so an
        // auditor filtering by type finds an overridden CRM contact as a contact, not a ticket.
        const entityType = await getEntityType(
          tx,
          tenantId,
          instance.entityTypeId,
        );
        await writeAuditEntry(tx, {
          tenantId,
          actorId: userId,
          actorType: "user",
          resourceType: entityType.name,
          resourceId: instanceId,
          action: "workflow.state_overridden",
          beforeSnapshot: { currentState: result.fromState },
          afterSnapshot: { currentState: result.toState },
          metadata: { reason: reason.trim(), workflowId: result.workflowId },
        });
        return result;
      });
      if (event === null) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      return c.json({ data: event });
    } catch (err) {
      if (err instanceof EntityError) return handleEntityError(c, err);
      return handleWorkflowError(c, err);
    }
  },
);
