import { z } from "zod";
import {
  treeUsesActorRule,
  type TransitionConditionTree,
} from "@platform/workflow-engine";

// Write-time validation for a workflow transition's `conditions`. Without it a typo such as
// "actor_not_creater" is stored, never matches anything, and silently makes the transition
// impossible to take (the engine fails closed on an unknown rule). Mirrors
// TransitionConditionTree; the compile-time guards at the bottom fail if the two drift.

const MAX_DEPTH = 8;
const MAX_CHILDREN = 20;

const FIELD_OPS = [
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
] as const;

// One object per operator (not one object with an enum) so every node can sit in a
// discriminated union keyed on `op`: the parser picks the branch from `op` alone instead of
// trying each branch and re-parsing the children of every one that fails.
const FieldConditionSchemas = FIELD_OPS.map((op) =>
  z.object({
    op: z.literal(op),
    field: z.string().min(1).max(200),
    value: z.unknown().optional(),
  }),
);
const ActorNotCreatorSchema = z
  .object({ op: z.literal("actor_not_creator") })
  .strict();
const ActorIsCreatorSchema = z
  .object({ op: z.literal("actor_is_creator") })
  .strict();
const ActorNotPriorActorSchema = z
  .object({
    op: z.literal("actor_not_prior_actor"),
    states: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
  })
  .strict();

type TransitionConditionInput =
  | { op: "and"; children: TransitionConditionInput[] }
  | { op: "or"; children: TransitionConditionInput[] }
  | { op: "not"; child: TransitionConditionInput }
  | { op: (typeof FIELD_OPS)[number]; field: string; value?: unknown }
  | z.infer<typeof ActorNotCreatorSchema>
  | z.infer<typeof ActorIsCreatorSchema>
  | z.infer<typeof ActorNotPriorActorSchema>;

type DiscriminatedOptions = [z.ZodObject, ...z.ZodObject[]];

const LEAVES = [
  ActorNotCreatorSchema,
  ActorIsCreatorSchema,
  ActorNotPriorActorSchema,
  ...FieldConditionSchemas,
];

// Built to a fixed depth instead of with z.lazy plus a depth check afterwards: a lazy schema
// parses the whole tree before any check runs, so a deeply nested payload would recurse first.
// Here the recursion is bounded by construction.
function treeSchema(levels: number): z.ZodType<TransitionConditionInput> {
  const options: unknown[] = [...LEAVES];
  if (levels > 1) {
    const child = treeSchema(levels - 1);
    options.push(
      z.object({
        op: z.literal("and"),
        children: z.array(child).min(1).max(MAX_CHILDREN),
      }),
      z.object({
        op: z.literal("or"),
        children: z.array(child).min(1).max(MAX_CHILDREN),
      }),
      z.object({ op: z.literal("not"), child }),
    );
  }
  // The options are all ZodObjects with a literal `op`, which is what a discriminated union
  // needs; the array is built dynamically so TypeScript cannot see the tuple shape.
  return z.discriminatedUnion(
    "op",
    options as unknown as DiscriminatedOptions,
  ) as unknown as z.ZodType<TransitionConditionInput>;
}

// `not` would turn an actor rule's refusal of an unidentified actor into a pass. To express
// "only the creator", use actor_is_creator. One linear walk after parsing, because a refine
// cannot sit inside a discriminated union.
function notOverActorRule(tree: TransitionConditionTree): boolean {
  if ("children" in tree) return tree.children.some(notOverActorRule);
  if ("child" in tree)
    return treeUsesActorRule(tree.child) || notOverActorRule(tree.child);
  return false;
}

export const TransitionConditionsSchema = treeSchema(MAX_DEPTH).superRefine(
  (tree, ctx) => {
    if (notOverActorRule(tree as TransitionConditionTree)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "actor rules cannot be placed under `not`; use actor_is_creator for 'only the creator'",
      });
    }
  },
);

// Bidirectional compile-time compatibility: a `never` here is a tsc error.
export type _AssertConditionsCompatible =
  TransitionConditionInput extends TransitionConditionTree ? true : never;
export type _AssertConditionsInverse =
  TransitionConditionTree extends TransitionConditionInput ? true : never;
