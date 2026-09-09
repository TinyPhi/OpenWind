import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// 3E on-call routing (docs/specs/oncall-routing.md T1-T3, R1d).
// Teams/services are plain Drizzle tables, not entity-engine entity types --
// see ADR-016 Decision 1: on-call lookup is a hot path and must be a single
// indexed query, not a JSONB traversal across entity_instances.

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Zitadel JWT sub claim, not a local uuid PK -- matches every other
    // user-reference column in this schema (entityInstances.createdBy,
    // tenantUsers.userId, etc.) -- self-caught after PR #583 review, not a
    // reviewer finding.
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
    tenantIdx: index("teams_tenant_idx").on(t.tenantId),
    // Soft-deleted rows free their name for reuse -- same pattern as labels (R1b).
    tenantNameUnique: uniqueIndex("teams_tenant_name_unique")
      .on(t.tenantId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Optional default owner team (R4) -- nullable, no ON DELETE CASCADE:
    // deleting a team must not cascade-delete its services (R4 invariant).
    teamId: uuid("team_id"),
    // Zitadel JWT sub claim, not a local uuid PK -- matches every other
    // user-reference column in this schema (entityInstances.createdBy,
    // tenantUsers.userId, etc.) -- self-caught after PR #583 review, not a
    // reviewer finding.
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
    tenantIdx: index("services_tenant_idx").on(t.tenantId),
    teamIdx: index("services_team_idx").on(t.teamId),
    tenantNameUnique: uniqueIndex("services_tenant_name_unique")
      .on(t.tenantId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

export const onCallSchedules = pgTable(
  "on_call_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    teamId: uuid("team_id").notNull(),
    label: text("label").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    // All three are Zitadel JWT sub claims, same reasoning as createdBy below.
    primaryUserId: text("primary_user_id").notNull(),
    backupUserId: text("backup_user_id"),
    escalationManagerUserId: text("escalation_manager_user_id"),
    // Zitadel JWT sub claim, not a local uuid PK -- matches every other
    // user-reference column in this schema (entityInstances.createdBy,
    // tenantUsers.userId, etc.) -- self-caught after PR #583 review, not a
    // reviewer finding.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Soft-delete only -- never hard-deleted, so audit entries referencing a
    // scheduleId remain resolvable after admin deletion (spec §V).
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("on_call_schedules_tenant_idx").on(t.tenantId),
    // Primary hot-path query: WHERE team_id = X AND tenant_id = Y AND
    // now() BETWEEN starts_at AND ends_at (R6, R8 -- p99 <= 100ms target).
    teamWindowIdx: index("on_call_schedules_team_window_idx").on(
      t.tenantId,
      t.teamId,
      t.startsAt,
      t.endsAt,
    ),
  }),
);

// The GIST exclusion constraint (no-overlap invariant, R5) and its
// `btree_gist` extension can't be expressed via Drizzle's schema builder --
// both are added by raw SQL in migration 0094_on_call_schedules_table.sql.
