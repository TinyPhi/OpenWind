import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { entityTypes, entityInstances } from "./entity-engine.js";
import { workflows } from "./workflow-engine.js";

// 3F temporal scheduler (docs/specs/temporal-scheduler.md T1-T3, R1-R9).
// entity_type_id/workflow_id keep a real FK (existence) + an app-layer
// tenant check (FK bypasses RLS) -- see migration 0101's comment.
// template's team_id/assignee_id/service_id live inside the JSONB
// column, not as separate columns -- purely app-layer validated at the
// Phase 2 route layer.

export const scheduleRules = pgTable(
  "schedule_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    cronExpr: text("cron_expr").notNull(),
    timezone: text("timezone").default("UTC").notNull(),

    entityTypeId: uuid("entity_type_id")
      .notNull()
      .references(() => entityTypes.id),
    workflowId: uuid("workflow_id").references(() => workflows.id, {
      onDelete: "restrict",
    }),
    template: jsonb("template").notNull(),

    status: text("status").default("active").notNull(),
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    catchUp: boolean("catch_up").default(false).notNull(),

    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    nameTenantUnique: uniqueIndex("schedule_rules_name_tenant_unique")
      .on(t.tenantId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    dueIdx: index("schedule_rules_due_idx")
      .on(t.nextFireAt)
      .where(sql`${t.status} = 'active' AND ${t.deletedAt} IS NULL`),
    tenantIdx: index("schedule_rules_tenant_idx")
      .on(t.tenantId)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

export const scheduleExecutions = pgTable(
  "schedule_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => scheduleRules.id, { onDelete: "restrict" }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    status: text("status").notNull(),
    entityInstanceId: uuid("entity_instance_id").references(
      () => entityInstances.id,
    ),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    ruleIdx: index("schedule_executions_rule_idx").on(t.ruleId, t.scheduledAt),
    tenantIdx: index("schedule_executions_tenant_idx").on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);
