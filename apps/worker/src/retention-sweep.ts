import { sql } from "drizzle-orm";
import {
  withEventLogMaintenanceContext,
  withTenantContext,
} from "@platform/db";
import { env } from "@platform/config";
import { retentionDeletedRowsTotal } from "@platform/telemetry";
import type { RetentionPolicy } from "./retention-policy.js";

export type RetentionClass = "noise" | "comment" | "evidence";

export interface RetentionSweepResult {
  workflowEventsNoise: number;
  workflowEventsComment: number;
  workflowEventsEvidence: number;
  outboxEvents: number;
  tenantUsageDaily: number;
  notificationRecipients: number;
  notifications: number;
  connectorDeliveryAttempts: number;
  deadLetterEvents: number;
  idempotencyKeys: number;
}

type Tx = Parameters<Parameters<typeof withTenantContext>[1]>[0];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Classification reads the state columns first, then metadata.type: an event that records creation
// or a state change is evidence, an untyped same-state event is noise, a comment has its own window,
// and a same-state event with any other type (an update, access grant or attachment record) is
// evidence. Evidence is also held back while its case is open or recently active.
const SAME_STATE_PREDICATES = {
  noise: sql`e.from_state = e.to_state AND e.metadata->>'type' IS NULL`,
  comment: sql`e.from_state = e.to_state AND e.metadata->>'type' = 'comment'`,
};

async function deleteBatch(
  tx: Tx,
  statement: ReturnType<typeof sql>,
): Promise<number> {
  const rows = await tx.execute(statement);
  return rows.length;
}

async function drain(
  tenantId: string,
  run: typeof withTenantContext,
  build: (limit: number) => ReturnType<typeof sql>,
  label: { table: string; class: string },
): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await run(tenantId, (tx) =>
      deleteBatch(tx, build(env.RETENTION_BATCH_SIZE)),
    );
    total += n;
    if (n < env.RETENTION_BATCH_SIZE) break;
    if (env.RETENTION_BATCH_PAUSE_MS > 0) {
      await sleep(env.RETENTION_BATCH_PAUSE_MS);
    }
  }
  if (total > 0) retentionDeletedRowsTotal.add(total, label);
  return total;
}

function workflowEventsBatch(
  tenantId: string,
  cls: RetentionClass,
  windowDays: number,
  evidenceDays: number,
  limit: number,
): ReturnType<typeof sql> {
  const predicate =
    cls === "evidence"
      ? sql`(e.from_state IS NULL OR e.from_state <> e.to_state
      OR (e.metadata->>'type' IS NOT NULL AND e.metadata->>'type' <> 'comment'))
    AND NOT EXISTS (
      SELECT 1 FROM entity_instances i
      LEFT JOIN workflow_states s
        ON s.workflow_id = i.workflow_id AND s.tenant_id = i.tenant_id AND s.name = i.current_state
      WHERE i.id = e.instance_id AND i.tenant_id = e.tenant_id AND i.deleted_at IS NULL
        AND (
          (i.workflow_id IS NOT NULL AND COALESCE(s.is_terminal, false) = false)
          OR i.updated_at >= now() - make_interval(days => ${evidenceDays})
        )
    )`
      : SAME_STATE_PREDICATES[cls];
  return sql`DELETE FROM workflow_events WHERE id IN (
    SELECT e.id FROM workflow_events e
    WHERE e.tenant_id = ${tenantId}
      AND e.created_at < now() - make_interval(days => ${windowDays})
      AND ${predicate}
    LIMIT ${limit}
  ) AND tenant_id = ${tenantId} RETURNING 1`;
}

export async function sweepTenant(
  tenantId: string,
  policy: RetentionPolicy,
): Promise<RetentionSweepResult> {
  const result: RetentionSweepResult = {
    workflowEventsNoise: 0,
    workflowEventsComment: 0,
    workflowEventsEvidence: 0,
    outboxEvents: 0,
    tenantUsageDaily: 0,
    notificationRecipients: 0,
    notifications: 0,
    connectorDeliveryAttempts: 0,
    deadLetterEvents: 0,
    idempotencyKeys: 0,
  };
  if (policy.hold) return result;

  result.workflowEventsNoise = await drain(
    tenantId,
    withEventLogMaintenanceContext,
    (limit) =>
      workflowEventsBatch(tenantId, "noise", policy.noiseDays, 0, limit),
    { table: "workflow_events", class: "noise" },
  );
  result.workflowEventsComment = await drain(
    tenantId,
    withEventLogMaintenanceContext,
    (limit) =>
      workflowEventsBatch(tenantId, "comment", policy.commentDays, 0, limit),
    { table: "workflow_events", class: "comment" },
  );
  result.workflowEventsEvidence = await drain(
    tenantId,
    withEventLogMaintenanceContext,
    (limit) =>
      workflowEventsBatch(
        tenantId,
        "evidence",
        policy.evidenceDays,
        policy.evidenceDays,
        limit,
      ),
    { table: "workflow_events", class: "evidence" },
  );
  result.outboxEvents = await drain(
    tenantId,
    withTenantContext,
    (limit) => sql`DELETE FROM outbox_events WHERE id IN (
      SELECT id FROM outbox_events
      WHERE tenant_id = ${tenantId} AND delivered_at IS NOT NULL
        AND notified_delivered_at IS NOT NULL
        AND created_at < now() - make_interval(days => ${policy.noiseDays})
      LIMIT ${limit}
    ) AND tenant_id = ${tenantId} RETURNING 1`,
    { table: "outbox_events", class: "noise" },
  );
  result.tenantUsageDaily = await drain(
    tenantId,
    withTenantContext,
    (limit) => sql`DELETE FROM tenant_usage_daily WHERE ctid IN (
      SELECT ctid FROM tenant_usage_daily
      WHERE tenant_id = ${tenantId}
        AND usage_date < (current_date - ${policy.noiseDays}::int)
      LIMIT ${limit}
    ) AND tenant_id = ${tenantId} RETURNING 1`,
    { table: "tenant_usage_daily", class: "noise" },
  );
  // Children before parents: recipients of aged notifications go first, then the notifications.
  // Recipients are matched through their parent's created_at so a late-added recipient never
  // outlives (or is cascade-deleted with) its notification inconsistently.
  result.notificationRecipients = await drain(
    tenantId,
    withTenantContext,
    (limit) => sql`DELETE FROM notification_recipients WHERE id IN (
      SELECT r.id FROM notification_recipients r
      JOIN notifications n ON n.id = r.notification_id AND n.tenant_id = r.tenant_id
      WHERE r.tenant_id = ${tenantId}
        AND n.created_at < now() - make_interval(days => ${policy.noiseDays})
      LIMIT ${limit}
    ) AND tenant_id = ${tenantId} RETURNING 1`,
    { table: "notification_recipients", class: "noise" },
  );
  result.notifications = await drain(
    tenantId,
    withTenantContext,
    (limit) => sql`DELETE FROM notifications WHERE id IN (
      SELECT id FROM notifications
      WHERE tenant_id = ${tenantId}
        AND created_at < now() - make_interval(days => ${policy.noiseDays})
      LIMIT ${limit}
    ) AND tenant_id = ${tenantId} RETURNING 1`,
    { table: "notifications", class: "noise" },
  );
  result.connectorDeliveryAttempts = await drain(
    tenantId,
    withTenantContext,
    (limit) => sql`DELETE FROM connector_delivery_attempts WHERE id IN (
      SELECT id FROM connector_delivery_attempts
      WHERE tenant_id = ${tenantId}
        AND created_at < now() - make_interval(days => ${policy.noiseDays})
      LIMIT ${limit}
    ) AND tenant_id = ${tenantId} RETURNING 1`,
    { table: "connector_delivery_attempts", class: "noise" },
  );
  result.deadLetterEvents = await drain(
    tenantId,
    withTenantContext,
    (limit) => sql`DELETE FROM dead_letter_events WHERE id IN (
      SELECT id FROM dead_letter_events
      WHERE tenant_id = ${tenantId}
        AND created_at < now() - make_interval(days => ${policy.noiseDays})
      LIMIT ${limit}
    ) AND tenant_id = ${tenantId} RETURNING 1`,
    { table: "dead_letter_events", class: "noise" },
  );
  // A key is dead once expires_at passes (24h TTL); the noise window then runs from expiry.
  result.idempotencyKeys = await drain(
    tenantId,
    withTenantContext,
    (limit) => sql`DELETE FROM idempotency_keys WHERE id IN (
      SELECT id FROM idempotency_keys
      WHERE tenant_id = ${tenantId}
        AND expires_at < now() - make_interval(days => ${policy.noiseDays})
      LIMIT ${limit}
    ) AND tenant_id = ${tenantId} RETURNING 1`,
    { table: "idempotency_keys", class: "noise" },
  );
  return result;
}
