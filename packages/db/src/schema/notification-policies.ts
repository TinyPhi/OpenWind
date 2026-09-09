import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// 3E on-call routing (docs/specs/oncall-routing.md T21-T22, R14-R15).
// team_id/workflow_type_id have NO foreign key -- app-layer cross-tenant
// validation only (R1d/T44), matching services.team_id's treatment.

export const notificationPolicies = pgTable(
  "notification_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    teamId: uuid("team_id"),
    workflowTypeId: uuid("workflow_type_id"),
    severity: text("severity").notNull(),
    channels: text("channels").array().notNull(),
    notifyBackup: boolean("notify_backup").default(true).notNull(),
    notifyEscalationManager: boolean("notify_escalation_manager")
      .default(false)
      .notNull(),
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
    tenantIdx: index("notification_policies_tenant_idx").on(t.tenantId),
    // Four specificity-level partial unique indexes -- see migration
    // 0099's comment (composite UNIQUE fails for nullable columns; NULL !=
    // NULL in Postgres composite uniques).
    globalSeverityUnique: uniqueIndex("notif_policy_global_severity")
      .on(t.tenantId, t.severity)
      .where(
        sql`${t.teamId} IS NULL AND ${t.workflowTypeId} IS NULL AND ${t.deletedAt} IS NULL`,
      ),
    teamSeverityUnique: uniqueIndex("notif_policy_team_severity")
      .on(t.tenantId, t.teamId, t.severity)
      .where(
        sql`${t.teamId} IS NOT NULL AND ${t.workflowTypeId} IS NULL AND ${t.deletedAt} IS NULL`,
      ),
    workflowSeverityUnique: uniqueIndex("notif_policy_workflow_severity")
      .on(t.tenantId, t.workflowTypeId, t.severity)
      .where(
        sql`${t.teamId} IS NULL AND ${t.workflowTypeId} IS NOT NULL AND ${t.deletedAt} IS NULL`,
      ),
    teamWorkflowSeverityUnique: uniqueIndex(
      "notif_policy_team_workflow_severity",
    )
      .on(t.tenantId, t.teamId, t.workflowTypeId, t.severity)
      .where(
        sql`${t.teamId} IS NOT NULL AND ${t.workflowTypeId} IS NOT NULL AND ${t.deletedAt} IS NULL`,
      ),
  }),
);
