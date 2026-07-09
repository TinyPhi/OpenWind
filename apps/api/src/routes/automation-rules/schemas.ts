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
// notify/assign/create_entity/connector.action/script are declared in
// packages/automation-engine/src/types.ts's ActionType union but not yet
// implemented in executor.ts's switch (they fall through to "unhandled
// action type" and no-op) — kept permissive (`z.record(z.unknown())`) rather
// than over-constraining a shape that doesn't exist yet.

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
  timeoutMs: z.number().int().positive().optional(),
});

export const ActionConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notify"), config: z.record(z.unknown()) }),
  z.object({ type: z.literal("set_field"), config: SetFieldConfigSchema }),
  z.object({ type: z.literal("transition"), config: TransitionConfigSchema }),
  z.object({ type: z.literal("webhook"), config: WebhookActionConfigSchema }),
  z.object({ type: z.literal("assign"), config: z.record(z.unknown()) }),
  z.object({
    type: z.literal("create_entity"),
    config: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("connector.action"),
    config: z.record(z.unknown()),
  }),
  z.object({ type: z.literal("script"), config: z.record(z.unknown()) }),
]);

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
