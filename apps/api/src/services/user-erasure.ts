import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  type DbOrTx,
  tenantUsers,
  savedViews,
  notificationRecipients,
  ticketAlerts,
  accessRequests,
  apiKeys,
  entityInstances,
  entityInstanceTags,
  workflows,
  workflowEvents,
  attachments,
  files,
  idempotencyKeys,
  connectorCredentials,
  labels,
  ticketLabels,
  notificationPolicies,
  teams,
  services,
  onCallSchedules,
  scheduleRules,
} from "@platform/db";

const REDACTED = "[REDACTED]";

/**
 * Every user-reference column (`table.column`) that eraseUserFromTenant scrubs.
 * The erasure coverage guard fails if a tenant table gains a user-reference
 * column that is neither listed here nor in USER_REFERENCE_COLUMNS_EXEMPT.
 */
export const USER_REFERENCE_COLUMNS_HANDLED: readonly string[] = [
  "saved_views.user_id",
  "notification_recipients.user_id",
  "ticket_alerts.created_by",
  "ticket_alerts.recipients_snapshot",
  "access_requests.requester_id",
  "access_requests.resolved_by",
  "api_keys.created_by",
  "api_keys.revoked_by",
  "entity_instances.created_by",
  "entity_instances.assigned_to",
  "entity_instances.origin_performer_user_id",
  "entity_instance_tags.created_by",
  "workflows.created_by",
  "workflows.assigned_to",
  "workflow_events.triggered_by",
  "workflow_events.actor_id",
  "workflow_events.origin_performer_user_id",
  "attachments.uploaded_by",
  "attachments.acting_person_id",
  "files.uploaded_by",
  "tenant_users.user_id",
  "idempotency_keys.acting_person_id",
  "connector_credentials.disabled_by",
  "labels.created_by",
  "ticket_labels.assigned_by",
  "notification_policies.created_by",
  "teams.created_by",
  "services.created_by",
  "on_call_schedules.primary_user_id",
  "on_call_schedules.backup_user_id",
  "on_call_schedules.escalation_manager_user_id",
  "on_call_schedules.created_by",
  "schedule_rules.created_by",
];

/** User-reference columns deliberately left untouched, with the reason. */
export const USER_REFERENCE_COLUMNS_EXEMPT: Readonly<Record<string, string>> = {
  "admin_audit_log.actor_id":
    "append-only security audit trail, kept under Art. 17(3)(b); anonymized only on tenant purge",
  "admin_audit_log.acting_person_id":
    "append-only security audit trail, kept under Art. 17(3)(b); anonymized only on tenant purge",
};

/**
 * GDPR Art. 17 per-user erasure within one tenant (docs/specs/gdpr-erasure-coverage.md).
 * Must run inside withTenantContext for `tenantId`. Deletes rows that are wholly
 * the user's; redacts or nulls the reference where the row belongs to someone
 * or something else. Every statement also filters on tenant_id explicitly.
 */
export async function eraseUserFromTenant(
  tx: DbOrTx,
  tenantId: string,
  targetUserId: string,
): Promise<void> {
  // saved_views RLS also requires user_id = app.user_id, and the caller is the
  // admin, not the target — switch the GUC to the target for this one delete
  // (transaction-local), then restore it.
  const [setting] = await tx.execute<{ current: string | null }>(
    sql`SELECT current_setting('app.user_id', true) AS current`,
  );
  await tx.execute(
    sql`SELECT set_config('app.user_id', ${targetUserId}, true)`,
  );
  await tx
    .delete(savedViews)
    .where(
      and(
        eq(savedViews.tenantId, tenantId),
        eq(savedViews.userId, targetUserId),
      ),
    );
  await tx.execute(
    sql`SELECT set_config('app.user_id', ${setting?.current ?? ""}, true)`,
  );

  await tx
    .delete(notificationRecipients)
    .where(
      and(
        eq(notificationRecipients.tenantId, tenantId),
        eq(notificationRecipients.userId, targetUserId),
      ),
    );

  await tx
    .delete(ticketAlerts)
    .where(
      and(
        eq(ticketAlerts.tenantId, tenantId),
        eq(ticketAlerts.createdBy, targetUserId),
      ),
    );
  // Someone else's alert that snapshotted the target as a recipient
  await tx
    .update(ticketAlerts)
    .set({
      recipientsSnapshot: sql`${ticketAlerts.recipientsSnapshot} - ${targetUserId}::text`,
    })
    .where(
      and(
        eq(ticketAlerts.tenantId, tenantId),
        sql`${ticketAlerts.recipientsSnapshot} ? ${targetUserId}::text`,
      ),
    );

  await tx
    .delete(accessRequests)
    .where(
      and(
        eq(accessRequests.tenantId, tenantId),
        eq(accessRequests.requesterId, targetUserId),
      ),
    );
  await tx
    .update(accessRequests)
    .set({ resolvedBy: REDACTED })
    .where(
      and(
        eq(accessRequests.tenantId, tenantId),
        eq(accessRequests.resolvedBy, targetUserId),
      ),
    );

  // A key rotated by someone else points back at the target's old key via
  // rotated_from (self-FK, NO ACTION) — clear that lineage pointer first.
  await tx
    .update(apiKeys)
    .set({ rotatedFrom: null })
    .where(
      and(
        eq(apiKeys.tenantId, tenantId),
        inArray(
          apiKeys.rotatedFrom,
          tx
            .select({ id: apiKeys.id })
            .from(apiKeys)
            .where(
              and(
                eq(apiKeys.tenantId, tenantId),
                eq(apiKeys.createdBy, targetUserId),
              ),
            ),
        ),
      ),
    );
  await tx
    .delete(apiKeys)
    .where(
      and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.createdBy, targetUserId)),
    );
  await tx
    .update(apiKeys)
    .set({ revokedBy: REDACTED })
    .where(
      and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.revokedBy, targetUserId)),
    );

  await tx
    .update(entityInstances)
    .set({ createdBy: null })
    .where(
      and(
        eq(entityInstances.tenantId, tenantId),
        eq(entityInstances.createdBy, targetUserId),
      ),
    );
  await tx
    .update(entityInstances)
    .set({ assignedTo: null })
    .where(
      and(
        eq(entityInstances.tenantId, tenantId),
        eq(entityInstances.assignedTo, targetUserId),
      ),
    );
  // origin_* is all-or-nothing (CHECK entity_instances_origin_all_or_nothing),
  // so the performer is redacted rather than nulled.
  await tx
    .update(entityInstances)
    .set({ originPerformerUserId: REDACTED })
    .where(
      and(
        eq(entityInstances.tenantId, tenantId),
        eq(entityInstances.originPerformerUserId, targetUserId),
      ),
    );
  // Per-record access grants live in the fields payload in two shapes: the
  // current {userId: {level, tag}} map and a legacy string[] still read by
  // entity-access.ts. `#-` with a text path element throws on an array, so
  // branch on the shape.
  await tx
    .update(entityInstances)
    .set({
      fields: sql`CASE jsonb_typeof(${entityInstances.fields} -> '__accessUsers')
        WHEN 'array' THEN jsonb_set(${entityInstances.fields}, '{__accessUsers}', (${entityInstances.fields} -> '__accessUsers') - ${targetUserId}::text)
        ELSE ${entityInstances.fields} #- ARRAY['__accessUsers', ${targetUserId}::text]
      END`,
    })
    .where(
      and(
        eq(entityInstances.tenantId, tenantId),
        sql`${entityInstances.fields} -> '__accessUsers' ? ${targetUserId}::text`,
      ),
    );

  await tx
    .update(entityInstanceTags)
    .set({ createdBy: REDACTED })
    .where(
      and(
        eq(entityInstanceTags.tenantId, tenantId),
        eq(entityInstanceTags.createdBy, targetUserId),
      ),
    );

  await tx
    .update(workflows)
    .set({ createdBy: null })
    .where(
      and(
        eq(workflows.tenantId, tenantId),
        eq(workflows.createdBy, targetUserId),
      ),
    );
  await tx
    .update(workflows)
    .set({
      assignedTo: sql`array_remove(${workflows.assignedTo}, ${targetUserId})`,
    })
    .where(
      and(
        eq(workflows.tenantId, tenantId),
        sql`${targetUserId} = ANY(${workflows.assignedTo})`,
      ),
    );

  await tx
    .update(workflowEvents)
    .set({ triggeredBy: REDACTED })
    .where(
      and(
        eq(workflowEvents.tenantId, tenantId),
        eq(workflowEvents.triggeredBy, targetUserId),
      ),
    );
  await tx
    .update(workflowEvents)
    .set({ actorId: REDACTED })
    .where(
      and(
        eq(workflowEvents.tenantId, tenantId),
        eq(workflowEvents.actorId, targetUserId),
      ),
    );
  await tx
    .update(workflowEvents)
    .set({ originPerformerUserId: REDACTED })
    .where(
      and(
        eq(workflowEvents.tenantId, tenantId),
        eq(workflowEvents.originPerformerUserId, targetUserId),
      ),
    );

  await tx
    .update(attachments)
    .set({
      uploadedBy: sql`CASE WHEN ${attachments.uploadedBy} = ${targetUserId} THEN ${REDACTED} ELSE ${attachments.uploadedBy} END`,
      actingPersonId: sql`CASE WHEN ${attachments.actingPersonId} = ${targetUserId} THEN ${REDACTED} ELSE ${attachments.actingPersonId} END`,
    })
    .where(
      and(
        eq(attachments.tenantId, tenantId),
        or(
          eq(attachments.uploadedBy, targetUserId),
          eq(attachments.actingPersonId, targetUserId),
        ),
      ),
    );
  await tx
    .update(files)
    .set({ uploadedBy: REDACTED })
    .where(
      and(eq(files.tenantId, tenantId), eq(files.uploadedBy, targetUserId)),
    );

  await tx
    .delete(tenantUsers)
    .where(
      and(
        eq(tenantUsers.tenantId, tenantId),
        eq(tenantUsers.userId, targetUserId),
      ),
    );
  await tx
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.tenantId, tenantId),
        eq(idempotencyKeys.actingPersonId, targetUserId),
      ),
    );

  await tx
    .update(connectorCredentials)
    .set({ disabledBy: REDACTED })
    .where(
      and(
        eq(connectorCredentials.tenantId, tenantId),
        eq(connectorCredentials.disabledBy, targetUserId),
      ),
    );
  await tx
    .update(labels)
    .set({ createdBy: REDACTED })
    .where(
      and(eq(labels.tenantId, tenantId), eq(labels.createdBy, targetUserId)),
    );
  await tx
    .update(ticketLabels)
    .set({ assignedBy: REDACTED })
    .where(
      and(
        eq(ticketLabels.tenantId, tenantId),
        eq(ticketLabels.assignedBy, targetUserId),
      ),
    );
  await tx
    .update(notificationPolicies)
    .set({ createdBy: REDACTED })
    .where(
      and(
        eq(notificationPolicies.tenantId, tenantId),
        eq(notificationPolicies.createdBy, targetUserId),
      ),
    );
  await tx
    .update(teams)
    .set({ createdBy: REDACTED })
    .where(
      and(eq(teams.tenantId, tenantId), eq(teams.createdBy, targetUserId)),
    );
  await tx
    .update(services)
    .set({ createdBy: REDACTED })
    .where(
      and(
        eq(services.tenantId, tenantId),
        eq(services.createdBy, targetUserId),
      ),
    );

  // On-call (decided 2026-09-27): a shift whose primary is the target is wholly
  // theirs and is deleted; other references are nulled or redacted.
  await tx
    .delete(onCallSchedules)
    .where(
      and(
        eq(onCallSchedules.tenantId, tenantId),
        eq(onCallSchedules.primaryUserId, targetUserId),
      ),
    );
  await tx
    .update(onCallSchedules)
    .set({ backupUserId: null })
    .where(
      and(
        eq(onCallSchedules.tenantId, tenantId),
        eq(onCallSchedules.backupUserId, targetUserId),
      ),
    );
  await tx
    .update(onCallSchedules)
    .set({ escalationManagerUserId: null })
    .where(
      and(
        eq(onCallSchedules.tenantId, tenantId),
        eq(onCallSchedules.escalationManagerUserId, targetUserId),
      ),
    );
  await tx
    .update(onCallSchedules)
    .set({ createdBy: REDACTED })
    .where(
      and(
        eq(onCallSchedules.tenantId, tenantId),
        eq(onCallSchedules.createdBy, targetUserId),
      ),
    );

  // ADR-017 Decision 5: a rule whose creator is gone logs failed executions
  // until an admin reassigns created_by — the accepted behaviour for an
  // inactive creator, which is what an erased creator is.
  await tx
    .update(scheduleRules)
    .set({ createdBy: REDACTED })
    .where(
      and(
        eq(scheduleRules.tenantId, tenantId),
        eq(scheduleRules.createdBy, targetUserId),
      ),
    );
}
