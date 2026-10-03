/**
 * Shared Zod schemas for automation-rule routes.
 * Single source of truth — imported by create.ts, update.ts, and list.ts.
 */
import { z } from "zod";
import type { ConditionTree } from "@platform/workflow-engine";

// ── Trigger types ─────────────────────────────────────────────────────────────

export const TRIGGER_TYPES = [
  "workflow.transitioned",
  "workflow.sla_breached",
  "entity.created",
  "entity.assigned",
  "entity.updated",
] as const;

// #684: accepted once but never emitted, so rules using them were silently
// inert. Migration 0132 converted or disabled the stored ones.
export const RETIRED_TRIGGER_TYPES: Readonly<Record<string, string>> = {
  "workflow.entered_state":
    "use workflow.transitioned with triggerConfig.toState",
  "field.changed": "use entity.updated with triggerConfig.field",
  "schedule.cron":
    "nothing emits it; use a schedule rule to create records on a schedule",
  "connector.event":
    "nothing emits it until the connector runtime ships (#368)",
};

export const TriggerTypeSchema = z.enum(TRIGGER_TYPES, {
  errorMap: (_issue, ctx) => {
    const hint =
      typeof ctx.data === "string"
        ? RETIRED_TRIGGER_TYPES[ctx.data]
        : undefined;
    return {
      message:
        hint !== undefined
          ? `${String(ctx.data)} is no longer supported: ${hint}`
          : ctx.defaultError,
    };
  },
});

// ── Action config ─────────────────────────────────────────────────────────────
// Discriminated by `type` so `config`'s shape is actually checked per action,
// not just accepted as an opaque record. The helpdesk module seed once shipped
// `{"type": "set-field", "field": ..., "value": ...}` (wrong literal, wrong
// nesting) against packages/automation-engine/src/executor.ts's `case
// "set_field"`, which expects `{"type": "set_field", "config": {"field": ...,
// "value": ...}}` — the rule silently matched no case and did nothing. Seed
// SQL bypasses this Zod validation entirely (raw INSERT, not this API route),
// so this schema protects only rules created/updated through the API — see
// the comment in modules/helpdesk/seed/003_automation_rules.sql for the seed
// side of this gap.
//
// notify now has a constrained config shape. connector.action is kept
// permissive (opaque Phase 3 shape). script was removed from the executor
// (#259) because no sandboxed implementation exists — reject it at the API
// boundary so rules with script actions don't get stored and silently
// error in the worker.

const NotifyConfigSchema = z.object({
  recipientId: z.string().min(1).optional(),
  channel: z.array(z.string()).optional(),
  payload: z
    .object({
      title: z.string().max(200).optional(),
      body: z.string().max(1000).optional(),
      link: z.string().optional(),
    })
    .optional(),
  // Wizard UI display state — symbolic recipient roles ("assignee", "creator",
  // "all_agents") and legacy field aliases. The executor only consumes
  // recipientId (a resolved user UUID) and channel. Resolution of symbolic
  // roles → recipientId is a Phase 3 feature; these fields are preserved here
  // so the wizard round-trips faithfully across save/re-open without silently
  // resetting user selections (the Zod default-strip behaviour).
  recipients: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  message: z.string().optional(),
});

const SetFieldConfigSchema = z.object({
  instanceId: z.string().optional(),
  field: z.string().min(1),
  value: z.unknown(),
});

const TransitionConfigSchema = z.object({
  instanceId: z.string().optional(),
  transitionId: z.string().min(1),
  comment: z.string().optional(),
});

const WebhookActionConfigSchema = z.object({
  url: z.string().url(),
  method: z.enum(["POST", "PUT", "PATCH"]).optional(),
  headers: z.record(z.string()).optional(),
  includePayload: z.boolean().optional(),
  sendFields: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const AssignConfigSchema = z.object({
  instanceId: z.string().optional(),
  assigneeId: z.string().min(1),
});

const CreateEntityConfigSchema = z.object({
  entityTypeId: z.string().min(1),
  fields: z.record(z.unknown()).optional(),
  assignedTo: z.string().optional(),
});

const CreateChildConfigSchema = z.object({
  entityTypeId: z.string().min(1).optional(),
  assignToUserId: z.string().min(1).nullable().optional(),
  descriptionTemplate: z.string().optional(),
  descriptionField: z.string().min(1).optional(),
  fields: z.record(z.unknown()).optional(),
  writeBackField: z.string().min(1).optional(),
});

const ResolveOncallConfigSchema = z.object({
  instanceId: z.string().uuid().optional(),
});

const DispatchSeverityNotificationConfigSchema = z.object({
  instanceId: z.string().uuid().optional(),
});

export const ActionConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notify"), config: NotifyConfigSchema }),
  z.object({ type: z.literal("set_field"), config: SetFieldConfigSchema }),
  z.object({ type: z.literal("transition"), config: TransitionConfigSchema }),
  z.object({ type: z.literal("webhook"), config: WebhookActionConfigSchema }),
  z.object({ type: z.literal("assign"), config: AssignConfigSchema }),
  z.object({
    type: z.literal("create_entity"),
    config: CreateEntityConfigSchema,
  }),
  z.object({
    type: z.literal("create_child"),
    config: CreateChildConfigSchema,
  }),
  z.object({
    type: z.literal("connector.action"),
    config: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("resolve_oncall"),
    config: ResolveOncallConfigSchema,
  }),
  z.object({
    type: z.literal("dispatch_severity_notification"),
    config: DispatchSeverityNotificationConfigSchema,
  }),
]);

// ── Trigger config ────────────────────────────────────────────────────────────
// Per-trigger-type config schemas, keyed by triggerType (#257).
// Used in create.ts and update.ts via .superRefine() so the config shape is
// validated against the chosen triggerType at the API boundary rather than
// failing silently at automation worker runtime.

// #684: a client's "any" option arrives as "", which would fail the uuid
// checks below and, for unvalidated keys, be stored. Treat it as unset.
export const TriggerConfigInputSchema = z
  .record(z.unknown())
  .transform((config) =>
    Object.fromEntries(Object.entries(config).filter(([, v]) => v !== "")),
  );

// Strict (#684): an unknown key is rejected rather than stored and ignored.
// The keys mirror the executor's TRIGGER_SCOPE_KEYS, plus `entityType` (a
// type name, used by module-seeded rules).
const workflowId = z.string().uuid().optional();
const entityTypeId = z.string().uuid().optional();
const entityType = z.string().min(1).optional();

export const TRIGGER_CONFIG_SCHEMAS = {
  "workflow.transitioned": z
    .object({
      workflowId,
      fromState: z.string().optional(),
      toState: z.string().optional(),
      entityTypeId,
      entityType,
    })
    .strict(),
  "workflow.sla_breached": z
    .object({
      workflowId,
      // Read by the executor since #678.
      state: z.string().optional(),
      entityTypeId,
      entityType,
    })
    .strict(),
  "entity.created": z.object({ entityTypeId, entityType }).strict(),
  "entity.assigned": z.object({ entityTypeId, entityType }).strict(),
  "entity.updated": z
    .object({
      entityTypeId,
      entityType,
      // Fires only when this field is in the event's `changed` map.
      field: z.string().min(1).optional(),
    })
    .strict(),
} satisfies Record<(typeof TRIGGER_TYPES)[number], z.ZodTypeAny>;

// ── Condition tree ────────────────────────────────────────────────────────────
// Mirrors ConditionTree from @platform/workflow-engine. Validated at write time
// so structural errors surface as 400s rather than silent executor failures.

const FieldConditionSchema = z.object({
  op: z.enum([
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "in",
    "empty",
    "not_empty",
  ]),
  field: z.string(),
  value: z.unknown().optional(),
});

export type ConditionTreeInput =
  | { op: "and"; children: ConditionTreeInput[] }
  | { op: "or"; children: ConditionTreeInput[] }
  | { op: "not"; child: ConditionTreeInput }
  | z.infer<typeof FieldConditionSchema>;

export const ConditionTreeSchema: z.ZodType<ConditionTreeInput> = z.lazy(() =>
  z.union([
    z.object({ op: z.literal("and"), children: z.array(ConditionTreeSchema) }),
    z.object({ op: z.literal("or"), children: z.array(ConditionTreeSchema) }),
    z.object({ op: z.literal("not"), child: ConditionTreeSchema }),
    FieldConditionSchema,
  ]),
);

// Bidirectional compile-time compatibility guards.
// _Forward: fails if workflow-engine adds a new operator that ConditionTreeSchema doesn't cover.
// _Inverse: fails if ConditionTreeInput drifts to accept shapes that ConditionTree rejects.
// Both must remain `true` — a `never` here is a tsc error.
export type _AssertConditionTreeCompatible =
  ConditionTreeInput extends ConditionTree ? true : never;
export type _AssertConditionTreeInverse =
  ConditionTree extends ConditionTreeInput ? true : never;
