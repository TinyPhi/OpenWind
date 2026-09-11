import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import { entityInstances } from "./entity-engine.js";

// 3E on-call routing (docs/specs/oncall-routing.md T34-T36, R1b/R1c).
// GitHub-style tenant-managed label vocabulary -- ADR-016 Decision 3.

export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    description: text("description"),
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
    tenantIdx: index("labels_tenant_idx").on(t.tenantId),
    tenantNameUnique: uniqueIndex("labels_tenant_name_unique")
      .on(t.tenantId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

// Junction table -- composite PK, no soft-delete (spec §V: rows are
// hard-deleted on explicit label removal, history lives in the audit log,
// not on this table). tenantId is denormalized so RLS can filter directly
// on this table without joining through entity_instances.
export const ticketLabels = pgTable(
  "ticket_labels",
  {
    ticketInstanceId: uuid("ticket_instance_id")
      .notNull()
      .references(() => entityInstances.id),
    // No .references() to labels.id -- cross-tenant ownership is an
    // app-layer check (R1d/T44), not a DB FK, same reasoning as
    // services.team_id (migration 0093).
    labelId: uuid("label_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    assignedBy: text("assigned_by").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticketInstanceId, t.labelId] }),
    tenantIdx: index("ticket_labels_tenant_idx").on(t.tenantId),
    labelIdx: index("ticket_labels_label_idx").on(t.tenantId, t.labelId),
  }),
);
