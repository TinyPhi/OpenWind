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

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id"),
    entityTypeId: uuid("entity_type_id")
      .notNull()
      .references(() => entityTypes.id),
    name: text("name").notNull(),
    initialState: text("initial_state").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    /** Zitadel user ID of the workflow's creator. Immutable after insert; always an implicit workflow admin. */
    createdBy: text("created_by"),
    /** Zitadel user IDs of the designated workflow admins (includes creator). NULL = unassigned. */
    assignedTo: text("assigned_to").array(),
    /** Max depth of parent→child chains. 0 = children disabled. Default 1. */
    maxChildDepth: integer("max_child_depth").default(1).notNull(),
    /** Max number of direct children per parent ticket. Default 10. */
    maxChildrenPerParent: integer("max_children_per_parent")
      .default(10)
      .notNull(),
    /**
     * ADR-012 Phase C, spec R5 — governs whether an API-submitted @mention of
     * someone with workflow-but-not-ticket access auto-grants read-only
     * access (true) or creates an access-request instead (false, default).
     */
    allowAutoGrantOnMention: boolean("allow_auto_grant_on_mention")
      .default(false)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // Closes issue #168: a tenant can have at most one workflow per entity
    // type. entityTypeId can never change after creation (no such field in
    // UpdateWorkflowInput), so createWorkflow is the only path that could
    // create a duplicate — this makes the 1:1 assumption the rest of the
    // code already relies on (getWorkflowByEntityTypeId) a real guarantee.
    tenantEntityTypeUnique: uniqueIndex(
      "workflows_tenant_entity_type_unique",
    ).on(t.tenantId, t.entityTypeId),
  }),
);

export const workflowStates = pgTable(
  "workflow_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Denormalized from workflows.tenant_id — see ADR-007. Always concrete: a
     * workflow's tenantId is never NULL (createWorkflow requires it), so its
     * states/transitions never need the NULL-tenant/system-template shape
     * entity_types/workflows use. */
    tenantId: uuid("tenant_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id),
    name: text("name").notNull(),
    label: text("label").notNull(),
    color: text("color").default("#888780"),
    isTerminal: boolean("is_terminal").default(false).notNull(),
    slaHours: integer("sla_hours"),
    sortOrder: integer("sort_order").default(0).notNull(),
  },
  (t) => ({
    tenantIdx: index("workflow_states_tenant_idx").on(t.tenantId),
  }),
);

export const workflowTransitions = pgTable(
  "workflow_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Denormalized from workflows.tenant_id — see ADR-007. */
    tenantId: uuid("tenant_id").notNull(),
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
    /** Monotonically increasing per-row insertion order (global sequence) — lets the
     * Actions tab list transitions in creation order instead of by (random) id. */
    sortOrder: integer("sort_order").generatedAlwaysAsIdentity().notNull(),
  },
  (t) => ({
    tenantIdx: index("workflow_transitions_tenant_idx").on(t.tenantId),
    workflowSortIdx: index("workflow_transitions_workflow_sort_idx").on(
      t.workflowId,
      t.sortOrder,
    ),
  }),
);

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
