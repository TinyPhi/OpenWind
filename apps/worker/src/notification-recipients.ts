import { eq, and } from "drizzle-orm";
import {
  withTenantContext,
  workflows,
  tenantUsers,
  entityInstances,
  accessRequests,
} from "@platform/db";
import { env } from "@platform/config";
import { z } from "zod";
import { logger } from "@platform/logger";

const EntityAssignedSchema = z.object({
  assignedBy: z.string().nullable().optional(),
  assigneeId: z.string(),
  instanceId: z.string().optional(),
});

const EntityUnassignedSchema = z.object({
  actorId: z.string().nullable().optional(),
  previousAssigneeId: z.string(),
  instanceId: z.string().optional(),
});

const CommentMentionedSchema = z.object({
  actorId: z.string(),
  mentionedUserIds: z.array(z.string()),
  instanceId: z.string().optional(),
});

const CommentRepliedSchema = z.object({
  actorId: z.string(),
  targetUserId: z.string(),
  instanceId: z.string().optional(),
});

const AccessGrantedRevokedSchema = z.object({
  actorId: z.string(),
  targetUserId: z.string(),
  instanceId: z.string().optional(),
});

const SlaBreachedSchema = z.object({
  workflowId: z.string(),
  instanceId: z.string().optional(),
});

const AccessRequestCreatedSchema = z.object({
  actorId: z.string().nullable().optional(),
  instanceId: z.string(),
  requestId: z.string().optional(),
});

const AccessRequestUpdatedSchema = z.object({
  actorId: z.string().nullable().optional(),
  instanceId: z.string(),
  requestId: z.string(),
  status: z.string().optional(),
});

const EntityUpdatedSchema = z.object({
  actorId: z.string().nullable().optional(),
  instanceId: z.string(),
});

const WorkflowTransitionedSchema = z.object({
  actorId: z.string().nullable().optional(),
  instanceId: z.string(),
  fromState: z.string().nullable().optional(),
  toState: z.string(),
});

const DueDateApproachingSchema = z.object({
  instanceId: z.string(),
});

const SystemErrorSchema = z.object({
  reason: z.string().optional(),
});

export interface ResolvedTrigger {
  recipients: string[];
  actorId: string | null;
  instanceId: string | undefined;
  reason: string | undefined;
}

// Dedupe + self-suppression (R2) — the actor performing the action is never
// notified about their own action. Applied uniformly here rather than per
// branch so no trigger type can accidentally skip it.
function finalize(recipients: string[], actorId: string | null): string[] {
  const unique = Array.from(new Set(recipients.filter((r) => r.length > 0)));
  return actorId ? unique.filter((r) => r !== actorId) : unique;
}

/**
 * Resolves recipients as a live snapshot at processing time (R3) — e.g.
 * workflow admins are read fresh from the workflows table on every call, not
 * cached from event-creation time, and never retroactively applied to a
 * notification already written.
 */
export async function resolveRecipients(
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<ResolvedTrigger> {
  switch (eventType) {
    case "entity.assigned": {
      const parsed = EntityAssignedSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          "Malformed payload for entity.assigned",
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;
      const actorId = data.assignedBy ?? null;
      const assigneeId = data.assigneeId;
      return {
        recipients: finalize([assigneeId], actorId),
        actorId,
        instanceId: data.instanceId,
        reason: undefined,
      };
    }

    case "entity.unassigned": {
      const parsed = EntityUnassignedSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          "Malformed payload for entity.unassigned",
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;
      const actorId = data.actorId ?? null;
      const previousAssigneeId = data.previousAssigneeId;
      return {
        // R2's self-suppression: if the previous assignee reassigned the
        // ticket away from themselves, they don't need telling.
        recipients: finalize([previousAssigneeId], actorId),
        actorId,
        instanceId: data.instanceId,
        reason: undefined,
      };
    }

    case "comment.mentioned":
    case "comment.mention_access_granted": {
      const parsed = CommentMentionedSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          `Malformed payload for ${eventType}`,
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;
      const actorId = data.actorId;
      const mentionedUserIds = data.mentionedUserIds;
      return {
        recipients: finalize(mentionedUserIds, actorId),
        actorId,
        instanceId: data.instanceId,
        reason: undefined,
      };
    }

    case "comment.replied": {
      const parsed = CommentRepliedSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          "Malformed payload for comment.replied",
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;
      const actorId = data.actorId;
      const targetUserId = data.targetUserId;
      return {
        recipients: finalize([targetUserId], actorId),
        actorId,
        instanceId: data.instanceId,
        reason: undefined,
      };
    }

    case "access.granted":
    case "access.revoked":
    case "access.updated": {
      const parsed = AccessGrantedRevokedSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          `Malformed payload for ${eventType}`,
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;
      const actorId = data.actorId;
      const targetUserId = data.targetUserId;
      return {
        recipients: finalize([targetUserId], actorId),
        actorId,
        instanceId: data.instanceId,
        reason: undefined,
      };
    }

    // Owner-facing: the ticket's creator/assignee need to know a request is
    // waiting on them. Deliberately NOT the broader __accessUsers ACL
    // (explicitAccessListUserIds) — that "everyone with access" list is for
    // ticket-alerts, not this; an access request is a decision only the
    // owner/assignee can act on, and notifying the wider ACL would tell people
    // who already have a read-only grant about a request they can't approve.
    case "access_request.created": {
      const parsed = AccessRequestCreatedSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          "Malformed payload for access_request.created",
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;
      const actorId = data.actorId ?? null;

      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            createdBy: entityInstances.createdBy,
            assignedTo: entityInstances.assignedTo,
          })
          .from(entityInstances)
          .where(
            and(
              eq(entityInstances.id, data.instanceId),
              eq(entityInstances.tenantId, tenantId),
            ),
          )
          .limit(1),
      );
      if (!instance)
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };

      const owners = [
        ...(instance.createdBy ? [instance.createdBy] : []),
        ...(instance.assignedTo ? [instance.assignedTo] : []),
      ];
      return {
        recipients: finalize(owners, actorId),
        actorId,
        instanceId: data.instanceId,
        reason: undefined,
      };
    }

    // Requester-facing: the person waiting on a decision, not the
    // creator/assignedTo who already know (one of them, or another
    // admin/agent, is who made the decision).
    case "access_request.updated": {
      const parsed = AccessRequestUpdatedSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          "Malformed payload for access_request.updated",
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;
      const actorId = data.actorId ?? null;

      const [request] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ requesterId: accessRequests.requesterId })
          .from(accessRequests)
          .where(
            and(
              eq(accessRequests.id, data.requestId),
              eq(accessRequests.tenantId, tenantId),
            ),
          )
          .limit(1),
      );
      if (!request)
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };

      return {
        recipients: finalize([request.requesterId], actorId),
        actorId,
        instanceId: data.instanceId,
        reason: data.status,
      };
    }

    // ui-feature-checklist-and-rules.md §2.5 — same creator+assignedTo-only
    // scoping as §2.4, for the same reason (not the full ACL).
    case "entity.updated": {
      const parsed = EntityUpdatedSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          "Malformed payload for entity.updated",
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;
      const actorId = data.actorId ?? null;

      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            createdBy: entityInstances.createdBy,
            assignedTo: entityInstances.assignedTo,
          })
          .from(entityInstances)
          .where(
            and(
              eq(entityInstances.id, data.instanceId),
              eq(entityInstances.tenantId, tenantId),
            ),
          )
          .limit(1),
      );
      if (!instance)
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };

      const owners = [
        ...(instance.createdBy ? [instance.createdBy] : []),
        ...(instance.assignedTo ? [instance.assignedTo] : []),
      ];
      return {
        recipients: finalize(owners, actorId),
        actorId,
        instanceId: data.instanceId,
        reason: undefined,
      };
    }

    // ui-feature-checklist-and-rules.md §2.4 — creator + assignedTo ONLY,
    // deliberately not the full __accessUsers ACL (unlike workflow.sla_breached
    // below, which notifies workflow ADMINS, a completely different
    // recipient set scoped by workflow, not by ticket).
    case "workflow.transitioned": {
      const parsed = WorkflowTransitionedSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          "Malformed payload for workflow.transitioned",
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;
      const actorId = data.actorId ?? null;

      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            createdBy: entityInstances.createdBy,
            assignedTo: entityInstances.assignedTo,
          })
          .from(entityInstances)
          .where(
            and(
              eq(entityInstances.id, data.instanceId),
              eq(entityInstances.tenantId, tenantId),
            ),
          )
          .limit(1),
      );
      if (!instance)
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };

      const owners = [
        ...(instance.createdBy ? [instance.createdBy] : []),
        ...(instance.assignedTo ? [instance.assignedTo] : []),
      ];
      return {
        recipients: finalize(owners, actorId),
        actorId,
        instanceId: data.instanceId,
        reason: data.toState,
      };
    }

    // ui-feature-checklist-and-rules.md §2.8 — deliberately the FULL access
    // list (creator + assignedTo + every __accessUsers entry), unlike §2.4/
    // §2.5/§2.9's creator+assignedTo-only scoping — this is the one rule that
    // explicitly wants everyone with a stake in the ticket warned, not just
    // its owners. No actor to self-suppress (system-triggered, not a user
    // action), so `finalize` is called with a null actorId.
    case "entity.due_date_approaching": {
      const parsed = DueDateApproachingSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          "Malformed payload for entity.due_date_approaching",
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;

      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            createdBy: entityInstances.createdBy,
            assignedTo: entityInstances.assignedTo,
            fields: entityInstances.fields,
          })
          .from(entityInstances)
          .where(
            and(
              eq(entityInstances.id, data.instanceId),
              eq(entityInstances.tenantId, tenantId),
            ),
          )
          .limit(1),
      );
      if (!instance)
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };

      const ids = new Set<string>();
      if (instance.createdBy) ids.add(instance.createdBy);
      if (instance.assignedTo) ids.add(instance.assignedTo);
      const accessUsers =
        (instance.fields as Record<string, unknown> | null)?.[
          "__accessUsers"
        ] ?? {};
      if (Array.isArray(accessUsers)) {
        for (const uid of accessUsers as string[]) ids.add(uid);
      } else if (typeof accessUsers === "object") {
        for (const uid of Object.keys(accessUsers as Record<string, unknown>)) {
          ids.add(uid);
        }
      }

      return {
        recipients: finalize(Array.from(ids), null),
        actorId: null,
        instanceId: data.instanceId,
        reason: undefined,
      };
    }

    case "workflow.sla_breached": {
      const parsed = SlaBreachedSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          "Malformed payload for workflow.sla_breached",
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;
      const workflowId = data.workflowId;

      const [workflow] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            createdBy: workflows.createdBy,
            assignedTo: workflows.assignedTo,
          })
          .from(workflows)
          .where(
            and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId)),
          )
          .limit(1),
      );

      if (!workflow)
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };

      const admins = [
        ...(workflow.createdBy ? [workflow.createdBy] : []),
        ...(workflow.assignedTo ?? []),
      ];
      return {
        recipients: finalize(admins, null),
        actorId: null,
        instanceId: data.instanceId,
        reason: undefined,
      };
    }

    case "system.error": {
      const parsed = SystemErrorSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn(
          { eventType, payload, error: parsed.error },
          "Malformed payload for system.error",
        );
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };
      }
      const data = parsed.data;

      const adminId = env.SYSTEM_ADMIN_USER_ID;
      if (!adminId)
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };

      const [membership] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ userId: tenantUsers.userId })
          .from(tenantUsers)
          .where(
            and(
              eq(tenantUsers.tenantId, tenantId),
              eq(tenantUsers.userId, adminId),
            ),
          )
          .limit(1),
      );

      if (!membership)
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };

      return {
        recipients: [adminId],
        actorId: null,
        instanceId: undefined,
        reason: data.reason,
      };
    }

    default:
      return {
        recipients: [],
        actorId: null,
        instanceId: undefined,
        reason: undefined,
      };
  }
}
