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
import { entityInstances, entityTypes } from "./entity-engine.js";

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id"),
  entityTypeId: uuid("entity_type_id")
    .notNull()
    .references(() => entityTypes.id),
  name: text("name").notNull(),
  initialState: text("initial_state").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  /** Zitadel user IDs of the designated workflow admins. NULL = unassigned. */
  assignedTo: text("assigned_to").array(),
  /** Max depth of parent→child chains. 0 = children disabled. Default 1. */
  maxChildDepth: integer("max_child_depth").default(1).notNull(),
  /** Max number of direct children per parent ticket. Default 10. */
  maxChildrenPerParent: integer("max_children_per_parent")
    .default(10)
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const workflowStates = pgTable("workflow_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id),
  name: text("name").notNull(),
  label: text("label").notNull(),
  color: text("color").default("#888780"),
  isTerminal: boolean("is_terminal").default(false).notNull(),
  slaHours: integer("sla_hours"),
  sortOrder: integer("sort_order").default(0).notNull(),
});

export const workflowTransitions = pgTable("workflow_transitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  label: text("label"),
  allowedRoles: text("allowed_roles").array().default([]).notNull(),
  conditions: jsonb("conditions"),
  requiresComment: boolean("requires_comment").default(false).notNull(),
  requiresFields: text("requires_fields").array().default([]).notNull(),
});

export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => entityInstances.id),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    triggeredBy: text("triggered_by").notNull(),
    actorId: text("actor_id"),
    comment: text("comment"),
    idempotencyKey: text("idempotency_key"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantInstanceIdx: index("workflow_events_tenant_instance_idx").on(
      t.tenantId,
      t.instanceId,
    ),
    instanceIdempotencyIdx: uniqueIndex(
      "workflow_events_instance_idempotency_idx",
    )
      .on(t.instanceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  }),
);
