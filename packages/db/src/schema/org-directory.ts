import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// docs/specs/org-directory.md T3 -- org-directory tree storage + sync-run tracking.
// Plain Drizzle-managed tables, not an entity-engine module -- same reasoning as
// packages/teams (ADR-016 Decision 1): tree/chain traversal is a hot path, must be
// indexed SQL, not a JSONB entity-engine walk.

export const orgEmployees = pgTable(
  "org_employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    // Zitadel JWT sub claim, not a local uuid PK. NULL only for the synthetic
    // root row (isRoot = true), which has no auth-provider identity.
    userId: text("user_id"),
    // Self-referential surrogate-key FK -- no ON DELETE action; app code must
    // reparent a node's children before deleting it (R5, per-user erasure).
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    title: text("title").notNull().default(""),
    // Lowercased at sync time (R6); empty string when unset.
    department: text("department").notNull().default(""),
    email: text("email").notNull().default(""),
    isRoot: boolean("is_root").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("org_employees_tenant_idx").on(t.tenantId),
    parentIdx: index("org_employees_parent_idx").on(t.parentId),
    // One row per (tenant, user) -- only enforced for real employees.
    tenantUserUnique: uniqueIndex("org_employees_tenant_user_unique")
      .on(t.tenantId, t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    // Exactly one root card per tenant (R3).
    tenantOneRootUnique: uniqueIndex("org_employees_tenant_one_root_unique")
      .on(t.tenantId)
      .where(sql`${t.isRoot} = true`),
  }),
);

export const orgDirectorySyncRuns = pgTable(
  "org_directory_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    employeeCount: integer("employee_count"),
    cyclesBroken: integer("cycles_broken"),
    reparented: integer("reparented"),
    // Zitadel JWT sub claim of the triggering admin; NULL for system-triggered
    // syncs (first-boot auto-seed, 24h scheduled job).
    triggeredBy: text("triggered_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("org_directory_sync_runs_tenant_idx").on(t.tenantId),
    // Per-tenant sync concurrency lock (R2) -- see migration 0128's header comment.
    oneRunningPerTenant: uniqueIndex(
      "org_directory_sync_runs_one_running_per_tenant",
    )
      .on(t.tenantId)
      .where(sql`${t.status} = 'running'`),
    statusCheck: check(
      "org_directory_sync_runs_status_check",
      sql`${t.status} IN ('running', 'completed', 'failed')`,
    ),
  }),
);
