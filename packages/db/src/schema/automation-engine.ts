import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const automationRules = pgTable("automation_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  triggerType: text("trigger_type").notNull(),
  triggerConfig: jsonb("trigger_config").notNull(),
  conditions: jsonb("conditions"),
  actions: jsonb("actions").notNull(),
  priority: integer("priority").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const automationExecutions = pgTable(
  "automation_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => automationRules.id),
    triggerEvent: jsonb("trigger_event").notNull(),
    status: text("status").notNull(),
    result: jsonb("result"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Identity of the workflow.transitioned event that triggered this
    // execution (see engine.ts's executeTransition). Only set for
    // transition-sourced executions — NULL for entity.created/entity.assigned
    // etc. Partial unique index below dedupes completed executions per
    // (ruleId, transitionEventId) without permanently blocking retry of a
    // failed one — see docs/specs/outbox-automation-idempotent-consumption.md.
    transitionEventId: uuid("transition_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantRuleIdx: index("automation_executions_tenant_rule_idx").on(
      t.tenantId,
      t.ruleId,
      t.status,
    ),
    // executor.ts's terminal statuses are 'success'/'degraded'/'failed', never
    // 'completed' (PR #372 review, H1) — 'completed' here would never match
    // any row, permanently disabling this index and Phase 2's dedup SELECT.
    ruleTransitionSuccessIdx: uniqueIndex(
      "automation_executions_rule_transition_success_idx",
    )
      .on(t.ruleId, t.transitionEventId)
      .where(
        sql`${t.transitionEventId} IS NOT NULL AND ${t.status} = 'success'`,
      ),
  }),
);

/**
 * outboxEvents — internal message bus / outbox queue.
 * RLS: Enabled (see 0049_outbox_events_rls.sql). Restricted to current tenant_id.
 * WORKER BYPASS: The background outbox poller executes under the master user database role,
 * which bypasses RLS and allows reading/delivering events across all tenants in a single batch.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    eventType: text("event_type").notNull(),
    version: integer("version").default(1).notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /**
     * Independent delivery-claim column for the notification worker (Phase 2
     * of in-app-notification-hub) — kept separate from `deliveredAt` (the
     * automation engine's claim column) so the two consumers never race for
     * the same row. See 0040_notifications.sql.
     */
    notifiedDeliveredAt: timestamp("notified_delivered_at", {
      withTimezone: true,
    }),
  },
  (t) => ({
    undeliveredIdx: index("outbox_events_undelivered_idx").on(
      t.deliveredAt,
      t.createdAt,
    ),
    notifiedUndeliveredIdx: index("outbox_events_notified_undelivered_idx").on(
      t.notifiedDeliveredAt,
      t.createdAt,
    ),
  }),
);

/**
 * Dead-letter store for outbox events that could not be processed after
 * exceeding the stale threshold (currently 48 h for SLA events).  Operators
 * can inspect this table to decide whether to re-trigger or discard.
 * RLS: Enabled (see 0049_outbox_events_rls.sql). Restricted to current tenant_id.
 * WORKER BYPASS: Background worker processes run under the master user role
 * and bypass RLS to write/manage dead lettered events across all tenants.
 */
export const deadLetterEvents = pgTable(
  "dead_letter_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /** The original outbox event that was dead-lettered. Nullable — set to NULL if the outbox row was deleted. */
    originalEventId: uuid("original_event_id").references(
      () => outboxEvents.id,
      { onDelete: "set null" },
    ),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    /** The automation rule that was being evaluated, if applicable. NULL for SLA events. */
    ruleId: uuid("rule_id").references(() => automationRules.id, {
      onDelete: "set null",
    }),
    error: text("error").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantCreatedIdx: index("dead_letter_events_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);
