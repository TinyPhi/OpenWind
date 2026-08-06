/**
 * Shared Zod schemas for automation-rule routes.
 * Single source of truth — imported by create.ts, update.ts, and list.ts.
 */
import { z } from "zod";
import type { ConditionTree } from "@platform/workflow-engine";

// ── Trigger types ─────────────────────────────────────────────────────────────

export const TRIGGER_TYPES = [
  "workflow.entered_state",
  "workflow.transitioned",
  "workflow.sla_breached",
  "field.changed",
  "entity.created",
  "entity.assigned",
  "schedule.cron",
  "connector.event",
] as const;

export const TriggerTypeSchema = z.enum(TRIGGER_TYPES);

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
]);

// ── Trigger config ────────────────────────────────────────────────────────────
// Per-trigger-type config schemas, keyed by triggerType (#257).
// Used in create.ts and update.ts via .superRefine() so the config shape is
// validated against the chosen triggerType at the API boundary rather than
// failing silently at automation worker runtime.
// connector.event and schedule.cron are kept permissive (Phase 3 shapes TBD).

export const TRIGGER_CONFIG_SCHEMAS = {
  "workflow.entered_state": z.object({
    workflowId: z.string().uuid().optional(),
    toState: z.string().optional(),
  }),
  "workflow.transitioned": z.object({
    workflowId: z.string().uuid().optional(),
    fromState: z.string().optional(),
    toState: z.string().optional(),
  }),
  "workflow.sla_breached": z.object({
    workflowId: z.string().uuid().optional(),
  }),
  "field.changed": z.object({
    entityTypeId: z.string().uuid(),
    field: z.string().min(1),
  }),
  "entity.created": z.object({
    entityTypeId: z.string().uuid().optional(),
  }),
  "entity.assigned": z.object({
    entityTypeId: z.string().uuid().optional(),
  }),
  "schedule.cron": z.object({ cron: z.string().min(1) }),
  "connector.event": z.record(z.unknown()),
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
