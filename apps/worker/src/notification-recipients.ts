import { eq, and } from "drizzle-orm";
import { withTenantContext, workflows, tenantUsers } from "@platform/db";
import { env } from "@platform/config";

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
      const actorId = (payload["assignedBy"] as string | null) ?? null;
      const assigneeId = payload["assigneeId"] as string;
      return {
        recipients: finalize([assigneeId], actorId),
        actorId,
        instanceId: payload["instanceId"] as string,
        reason: undefined,
      };
    }

    case "comment.mentioned": {
      const actorId = payload["actorId"] as string;
      const mentionedUserIds = payload["mentionedUserIds"] as string[];
      return {
        recipients: finalize(mentionedUserIds, actorId),
        actorId,
        instanceId: payload["instanceId"] as string,
        reason: undefined,
      };
    }

    case "comment.mention_access_granted": {
      const actorId = payload["actorId"] as string;
      const mentionedUserIds = payload["mentionedUserIds"] as string[];
      return {
        recipients: finalize(mentionedUserIds, actorId),
        actorId,
        instanceId: payload["instanceId"] as string,
        reason: undefined,
      };
    }

    case "comment.replied": {
      const actorId = payload["actorId"] as string;
      const targetUserId = payload["targetUserId"] as string;
      return {
        // finalize() also covers the case where the parent comment's author
        // replies to their own comment — self-suppressed like every other
        // trigger, not special-cased here.
        recipients: finalize([targetUserId], actorId),
        actorId,
        instanceId: payload["instanceId"] as string,
        reason: undefined,
      };
    }

    case "access.granted":
    case "access.revoked": {
      const actorId = payload["actorId"] as string;
      const targetUserId = payload["targetUserId"] as string;
      return {
        recipients: finalize([targetUserId], actorId),
        actorId,
        instanceId: payload["instanceId"] as string,
        reason: undefined,
      };
    }

    case "workflow.sla_breached": {
      const workflowId = payload["workflowId"] as string;
      // workflows has RLS (0037_rls_workflow_config_tables.sql) — this worker
      // runs as app_user (no BYPASSRLS), so a bare db.select() here sees no
      // rows and every sla_breached event silently produces no notification.
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
        instanceId: payload["instanceId"] as string | undefined,
        reason: undefined,
      };
    }

    case "system.error": {
      // Single hardcoded admin recipient (see packages/config/src/env.ts's
      // SYSTEM_ADMIN_USER_ID comment) — role membership isn't queryable from
      // our DB today. Still tenant-scoped: only notify if that admin is
      // actually a member of this tenant.
      const adminId = env.SYSTEM_ADMIN_USER_ID;
      if (!adminId)
        return {
          recipients: [],
          actorId: null,
          instanceId: undefined,
          reason: undefined,
        };

      // tenant_users has RLS — must go through withTenantContext (see
      // notification-worker.ts's resolveActorName for the same reasoning).
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
        reason: payload["reason"] as string | undefined,
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
