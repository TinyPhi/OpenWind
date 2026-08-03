import { eq, and } from "drizzle-orm";
import { withTenantContext, workflows, tenantUsers } from "@platform/db";
import { env } from "@platform/config";
import { z } from "zod";
import { logger } from "@platform/logger";

const EntityAssignedSchema = z.object({
  assignedBy: z.string().nullable().optional(),
  assigneeId: z.string(),
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
    case "access.revoked": {
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
