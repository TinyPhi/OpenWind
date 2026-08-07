import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  unique,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const entityTypes = pgTable("entity_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id"),
  name: text("name").notNull(),
  plural: text("plural").notNull(),
  icon: text("icon"),
  moduleId: uuid("module_id"),
  allowCustomFields: boolean("allow_custom_fields").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const entityFields = pgTable(
  "entity_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityTypeId: uuid("entity_type_id")
      .notNull()
      .references(() => entityTypes.id),
    tenantId: uuid("tenant_id"),
    name: text("name").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").notNull(),
    config: jsonb("config").default({}).notNull(),
    isRequired: boolean("is_required").default(false).notNull(),
    isIndexed: boolean("is_indexed").default(false).notNull(),
    isSystem: boolean("is_system").default(false).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    /**
     * PII classification — controls redaction when values are written to
     * workflow_events.metadata.  Default: 'internal'.
     * 'pii' and 'financial' values are replaced with "[REDACTED]" at INSERT.
     */
    sensitivity: text("sensitivity").default("internal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    entityTypeNameUnique: unique().on(t.entityTypeId, t.name),
  }),
);

export const entityInstances = pgTable(
  "entity_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityTypeId: uuid("entity_type_id")
      .notNull()
      .references(() => entityTypes.id),
    tenantId: uuid("tenant_id").notNull(),
    workflowId: uuid("workflow_id"),
    currentState: text("current_state").default("initial").notNull(),
    fields: jsonb("fields").default({}).notNull(),
    createdBy: text("created_by"),
    assignedTo: text("assigned_to"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    searchVector: tsvector("search_vector"),
  },
  (t) => ({
    tenantTypeIdx: index("entity_instances_tenant_type_idx").on(
      t.tenantId,
      t.entityTypeId,
    ),
    tenantStateIdx: index("entity_instances_tenant_state_idx").on(
      t.tenantId,
      t.currentState,
    ),
    tenantDeletedIdx: index("entity_instances_tenant_deleted_idx").on(
      t.tenantId,
      t.deletedAt,
    ),
    cursorIdx: index("entity_instances_cursor_idx").on(
      t.tenantId,
      t.entityTypeId,
      t.createdAt,
      t.id,
    ),
    searchIdx: index("entity_instances_search_idx").using(
      "gin",
      t.searchVector,
    ),
  }),
);

export const entityRelations = pgTable(
  "entity_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    fromInstanceId: uuid("from_instance_id")
      .notNull()
      .references(() => entityInstances.id),
    toInstanceId: uuid("to_instance_id")
      .notNull()
      .references(() => entityInstances.id),
    relationType: text("relation_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    activeFromIdx: index("entity_relations_active_from_idx")
      .on(t.tenantId, t.fromInstanceId)
      .where(sql`${t.deletedAt} IS NULL`),
    activeToIdx: index("entity_relations_active_to_idx")
      .on(t.tenantId, t.toInstanceId)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

export const ticketAlerts = pgTable(
  "ticket_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => entityInstances.id),
    createdBy: text("created_by").notNull(),
    note: text("note").notNull(),
    fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
    scope: text("scope").$type<"me" | "all">().notNull(),
    recipientsSnapshot: jsonb("recipients_snapshot").$type<string[]>(),
    status: text("status")
      .$type<"pending" | "fired" | "cancelled">()
      .notNull()
      .default("pending"),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantInstanceIdx: index("ticket_alerts_tenant_instance_idx").on(
      t.tenantId,
      t.instanceId,
    ),
    tenantCreatedByIdx: index("ticket_alerts_tenant_created_by_idx").on(
      t.tenantId,
      t.createdBy,
    ),
  }),
);

export const accessRequests = pgTable(
  "access_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => entityInstances.id),
    requesterId: text("requester_id").notNull(),
    requestedLevel: text("requested_level")
      .$type<"read_only" | "read_comment" | "read_write">()
      .notNull(),
    status: text("status")
      .$type<"pending" | "approved" | "rejected">()
      .notNull()
      .default("pending"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantInstanceIdx: index("access_requests_tenant_instance_idx").on(
      t.tenantId,
      t.instanceId,
    ),
    tenantRequesterIdx: index("access_requests_tenant_requester_idx").on(
      t.tenantId,
      t.requesterId,
    ),
  }),
);
