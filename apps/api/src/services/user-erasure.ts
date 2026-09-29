import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  type DbOrTx,
  entityFields,
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
  orgEmployees,
  orgDirectorySyncRuns,
} from "@platform/db";
import type { EntityField } from "@platform/entity-engine";

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
  "org_employees.user_id",
  "org_directory_sync_runs.triggered_by",
];

/** User-reference columns deliberately left untouched, with the reason. */
export const USER_REFERENCE_COLUMNS_EXEMPT: Readonly<Record<string, string>> = {
  "workflow_events.triggered_by":
    "not a user reference: holds the trigger type ('user', 'automation', 'api', 'system') — matched by the guard's column-name pattern only; the author is workflow_events.actor_id",
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
/** Days an erased user's API keys keep working before they expire (#688). */
export const API_KEY_ROTATION_GRACE_DAYS = 30;

export type UserErasureResult = {
  /** Keys the target created, now on a forced rotation window. */
  rotatedApiKeys: Array<{ id: string; expiresAt: Date | null }>;
};

export async function eraseUserFromTenant(
  tx: DbOrTx,
  tenantId: string,
  targetUserId: string,
): Promise<UserErasureResult> {
  // Read before tenant_users is deleted below: the text rewrite needs it.
  const [member] = await tx
    .select({ displayName: tenantUsers.displayName })
    .from(tenantUsers)
    .where(
      and(
        eq(tenantUsers.tenantId, tenantId),
        eq(tenantUsers.userId, targetUserId),
      ),
    )
    .limit(1);
  await scrubComments(tx, tenantId, targetUserId, member?.displayName ?? null);
  await scrubUserRefFields(tx, tenantId, targetUserId);

  // saved_views RLS also requires user_id = app.user_id, and the caller is the
  // admin, not the target — switch the GUC to the target for this one delete
  // (transaction-local), then restore it. The savepoint (nested transaction)
  // makes the restore structural: if the delete throws, ROLLBACK TO SAVEPOINT
  // also reverts the GUC, so a caller that catches and carries on in the same
  // transaction never keeps the target's user id as app.user_id.
  // The restore passes NULL when app.user_id was unset, meaning "back to
  // nothing". Postgres still *reads* an unregistered custom GUC back as ''
  // after any set_config in the session — so do pooled connections generally —
  // which is why policies reading app.user_id must use
  // NULLIF(current_setting(...), '') before any cast (db-conventions.md).
  await tx.transaction(async (sp) => {
    const [setting] = await sp.execute<{ current: string | null }>(
      sql`SELECT current_setting('app.user_id', true) AS current`,
    );
    await sp.execute(
      sql`SELECT set_config('app.user_id', ${targetUserId}, true)`,
    );
    await sp
      .delete(savedViews)
      .where(
        and(
          eq(savedViews.tenantId, tenantId),
          eq(savedViews.userId, targetUserId),
        ),
      );
    await sp.execute(
      sql`SELECT set_config('app.user_id', ${setting?.current ?? null}, true)`,
    );
  });

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

  // #688: a pending request from an erased user is dead and goes; a resolved
  // one is access-grant history and stays, anonymized.
  await tx
    .delete(accessRequests)
    .where(
      and(
        eq(accessRequests.tenantId, tenantId),
        eq(accessRequests.requesterId, targetUserId),
        eq(accessRequests.status, "pending"),
      ),
    );
  await tx
    .update(accessRequests)
    .set({ requesterId: REDACTED })
    .where(
      and(
        eq(accessRequests.tenantId, tenantId),
        eq(accessRequests.requesterId, targetUserId),
        // status is CHECK-constrained to pending/approved/rejected, so this
        // plus the pending delete above covers every row.
        ne(accessRequests.status, "pending"),
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

  // #688: keys are org-owned integration credentials (scopes live on the key,
  // not the creator), so they survive — deleting them broke live
  // integrations. But the erased person may still hold the secret, so each
  // key gets a forced rotation window: expires_at is pulled in to at most
  // API_KEY_ROTATION_GRACE_DAYS from now (ADR-008 expiry, enforced at auth),
  // and the caller audits each key so admins can find what to rotate.
  const rotateBy = new Date(
    Date.now() + API_KEY_ROTATION_GRACE_DAYS * 24 * 60 * 60 * 1000,
  );
  const rotatedApiKeys = await tx
    .update(apiKeys)
    .set({
      createdBy: REDACTED,
      expiresAt: sql`LEAST(COALESCE(${apiKeys.expiresAt}, ${rotateBy.toISOString()}::timestamptz), ${rotateBy.toISOString()}::timestamptz)`,
    })
    .where(
      and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.createdBy, targetUserId)),
    )
    .returning({ id: apiKeys.id, expiresAt: apiKeys.expiresAt });
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

  // Third-party writes record the acting person in metadata too, and the
  // actor may be the API key rather than the person, so match it directly.
  await tx
    .update(workflowEvents)
    .set({
      metadata: sql`jsonb_set(${workflowEvents.metadata}, '{actingPersonId}', to_jsonb(${REDACTED}::text))`,
    })
    .where(
      and(
        eq(workflowEvents.tenantId, tenantId),
        sql`jsonb_typeof(${workflowEvents.metadata}) = 'object'`,
        sql`${workflowEvents.metadata} ->> 'actingPersonId' = ${targetUserId}`,
      ),
    );
  // Field-change history: metadata.changed.<field> = {old, new}
  await tx
    .update(workflowEvents)
    .set({
      metadata: sql`jsonb_set(${workflowEvents.metadata}, '{changed}', COALESCE((
        SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(v) = 'object' THEN v
          || CASE WHEN v ->> 'old' = ${targetUserId} THEN jsonb_build_object('old', ${REDACTED}::text) ELSE '{}'::jsonb END
          || CASE WHEN v ->> 'new' = ${targetUserId} THEN jsonb_build_object('new', ${REDACTED}::text) ELSE '{}'::jsonb END
          ELSE v END)
        FROM jsonb_each(${workflowEvents.metadata} -> 'changed') AS e(k, v)), '{}'::jsonb))`,
    })
    .where(
      and(
        eq(workflowEvents.tenantId, tenantId),
        sql`jsonb_typeof(${workflowEvents.metadata} -> 'changed') = 'object'`,
        sql`EXISTS (SELECT 1 FROM jsonb_each(${workflowEvents.metadata} -> 'changed') AS e(k, v)
          WHERE jsonb_typeof(v) = 'object' AND (v ->> 'old' = ${targetUserId} OR v ->> 'new' = ${targetUserId}))`,
      ),
    );

  // The event's actorName is a display-name snapshot of the same person. Match on
  // actor_id: triggered_by holds the trigger type ('user', 'automation', 'api',
  // 'system'), never a user id, so it is left untouched (and exempt above).
  await tx
    .update(workflowEvents)
    .set({
      actorId: REDACTED,
      metadata: sql`CASE WHEN ${workflowEvents.metadata} ? 'actorName'
        THEN jsonb_set(${workflowEvents.metadata}, '{actorName}', to_jsonb(${REDACTED}::text))
        ELSE ${workflowEvents.metadata} END`,
    })
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

  // On-call (#688): every shift is kept with the primary redacted. The
  // resolver skips an unresolvable primary and pages backup, then escalation
  // (packages/teams oncall-resolver.ts), so a current or future shift keeps
  // its remaining cover; an ended one is coverage history.
  // primary/backup/escalation user columns are Zitadel `sub` text with no FK to
  // tenant_users (migration 0094), so redacting them here cannot block the
  // tenant_users DELETE at the end of this function.
  await tx
    .update(onCallSchedules)
    .set({ primaryUserId: REDACTED })
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

  // docs/specs/org-directory.md T12 -- reparent this user's direct reports one hop
  // up to their own parent (same mechanic as R5's manager-removal reparent,
  // simpler here since we already have the row's own parent_id on hand, no
  // prior-tree diff needed), then delete the row itself. This table mirrors an
  // external identity's own record, not a tenant-owned resource referencing the
  // user, so "redact the reference" doesn't apply the way it does for the
  // created_by-style columns above -- the whole row IS the erased user.
  const [erasedEmployee] = await tx
    .select({ id: orgEmployees.id, parentId: orgEmployees.parentId })
    .from(orgEmployees)
    .where(
      and(
        eq(orgEmployees.tenantId, tenantId),
        eq(orgEmployees.userId, targetUserId),
      ),
    )
    .limit(1);
  if (erasedEmployee) {
    // R3 fallback: a parentless non-root employee (shouldn't happen post-sync,
    // but nothing in the schema forbids it) reparents its reports to the
    // tenant's root rather than detaching them with a null parent_id.
    let fallbackParentId = erasedEmployee.parentId;
    if (fallbackParentId === null) {
      const [root] = await tx
        .select({ id: orgEmployees.id })
        .from(orgEmployees)
        .where(
          and(
            eq(orgEmployees.tenantId, tenantId),
            eq(orgEmployees.isRoot, true),
          ),
        )
        .limit(1);
      fallbackParentId = root?.id ?? null;
    }
    await tx
      .update(orgEmployees)
      .set({ parentId: fallbackParentId })
      .where(
        and(
          eq(orgEmployees.tenantId, tenantId),
          eq(orgEmployees.parentId, erasedEmployee.id),
        ),
      );
    await tx
      .delete(orgEmployees)
      .where(
        and(
          eq(orgEmployees.tenantId, tenantId),
          eq(orgEmployees.id, erasedEmployee.id),
        ),
      );
  }
  await tx
    .update(orgDirectorySyncRuns)
    .set({ triggeredBy: REDACTED })
    .where(
      and(
        eq(orgDirectorySyncRuns.tenantId, tenantId),
        eq(orgDirectorySyncRuns.triggeredBy, targetUserId),
      ),
    );

  // Last: tenant membership (and the acting-person replay cache tied to it)
  // goes only after every footprint of the user in the tenant is scrubbed.
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

  return { rotatedApiKeys };
}

/**
 * Which field types store a user id in entity_instances.fields (#688).
 * Exhaustive over EntityField["fieldType"], so adding a field type fails
 * typecheck until it is classified here.
 */
export const USER_ID_FIELD_TYPES: Readonly<
  Record<EntityField["fieldType"], boolean>
> = {
  text: false,
  longtext: false,
  number: false,
  currency: false,
  date: false,
  datetime: false,
  boolean: false,
  enum: false,
  select: false,
  multi_enum: false,
  user_ref: true,
  entity_ref: false,
  file: false,
  files: false,
  formula: false,
  lookup: false,
};

const USER_ID_FIELD_TYPE_NAMES = Object.entries(USER_ID_FIELD_TYPES)
  .filter(([, holdsUserId]) => holdsUserId)
  .map(([type]) => type);

// Optional user-id fields lose the key; required ones can't be emptied, so
// they are redacted. System-template fields (tenant_id NULL) apply to this
// tenant's instances too. entity_instances.fields is flat by the entity-engine
// contract — every field is a top-level key named by entity_fields.name — so a
// single-element path reaches every user_ref value.
async function scrubUserRefFields(
  tx: DbOrTx,
  tenantId: string,
  targetUserId: string,
): Promise<void> {
  const refFields = await tx
    .select({
      entityTypeId: entityFields.entityTypeId,
      name: entityFields.name,
      isRequired: entityFields.isRequired,
    })
    .from(entityFields)
    .where(
      and(
        inArray(entityFields.fieldType, USER_ID_FIELD_TYPE_NAMES),
        or(eq(entityFields.tenantId, tenantId), isNull(entityFields.tenantId)),
      ),
    );
  for (const field of refFields) {
    await tx
      .update(entityInstances)
      .set({
        fields: field.isRequired
          ? sql`jsonb_set(${entityInstances.fields}, ARRAY[${field.name}::text], to_jsonb(${REDACTED}::text))`
          : sql`${entityInstances.fields} - ${field.name}::text`,
      })
      .where(
        and(
          eq(entityInstances.tenantId, tenantId),
          eq(entityInstances.entityTypeId, field.entityTypeId),
          sql`${entityInstances.fields} ->> ${field.name}::text = ${targetUserId}`,
        ),
      );
  }
}

// Comments are workflow_events with metadata {type, text, mentions[], ...}.
// Only comments that recorded a mention of the target are touched: the id is
// removed from mentions, and "@<display name>" in their text becomes
// "@[REDACTED]" — a same-named person in other comments is left alone.
async function scrubComments(
  tx: DbOrTx,
  tenantId: string,
  targetUserId: string,
  displayName: string | null,
): Promise<void> {
  // Word-boundary match: target "Ann" must not rewrite "@Anne". Very short
  // names are too likely to collide, so their text is left alone (ids are
  // still scrubbed from mentions).
  const name = displayName?.trim() ?? "";
  const pattern =
    name.length >= 3
      ? `@${name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}(?![[:alnum:]_])`
      : null;
  const withoutMention = sql`jsonb_set(${workflowEvents.metadata}, '{mentions}', (${workflowEvents.metadata} -> 'mentions') - ${targetUserId}::text)`;
  const metadata = pattern
    ? sql`CASE WHEN jsonb_typeof(${workflowEvents.metadata} -> 'text') = 'string'
        THEN jsonb_set(${withoutMention}, '{text}', to_jsonb(regexp_replace(${workflowEvents.metadata} ->> 'text', ${pattern}::text, '@[REDACTED]', 'g')))
        ELSE ${withoutMention} END`
    : withoutMention;
  await tx
    .update(workflowEvents)
    .set({ metadata })
    .where(
      and(
        eq(workflowEvents.tenantId, tenantId),
        sql`jsonb_typeof(${workflowEvents.metadata} -> 'mentions') = 'array'`,
        sql`${workflowEvents.metadata} -> 'mentions' ? ${targetUserId}::text`,
      ),
    );
}
