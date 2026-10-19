import type {
  ActorContext,
  ConditionTree,
  FieldCondition,
  TransitionConditionTree,
} from "./types.js";

/**
 * `actor` is only needed for the actor rules (actor_not_creator, actor_not_prior_actor). A tree
 * that uses one without it evaluates to false: segregation of duties fails closed.
 */
export function evaluateConditionTree(
  tree: ConditionTree | TransitionConditionTree | null,
  fields: Record<string, unknown>,
  actor?: ActorContext,
): boolean {
  if (tree === null) return true;

  if ("children" in tree) {
    if (tree.op === "or")
      return tree.children.some((c) => evaluateConditionTree(c, fields, actor));
    return tree.children.every((c) => evaluateConditionTree(c, fields, actor));
  }
  if ("child" in tree) {
    // An actor rule fails closed for an unidentified actor; `not` would turn that refusal into
    // a pass, so a `not` over one is never satisfied. (The schema rejects it at write time;
    // this covers rows that reached the table another way, such as seed SQL.)
    if (treeUsesActorRule(tree.child)) return false;
    return !evaluateConditionTree(tree.child, fields, actor);
  }
  const actorId = actor?.actorId ?? null;
  if (tree.op === "actor_not_creator") {
    return actorId !== null && actorId !== (actor?.createdBy ?? null);
  }
  if (tree.op === "actor_is_creator") {
    return actorId !== null && actorId === actor?.createdBy;
  }
  if (tree.op === "actor_not_prior_actor") {
    const prior = actor?.priorActors;
    const states = tree.states;
    return (
      actorId !== null &&
      prior !== undefined &&
      !prior.some(
        (p) =>
          p.actorId === actorId &&
          (states === undefined || states.includes(p.fromState)),
      )
    );
  }

  return evaluateFieldCondition(tree, fields);
}

/** True when the tree contains any actor rule. */
export function treeUsesActorRule(
  tree: TransitionConditionTree | null,
): boolean {
  if (tree === null) return false;
  if ("children" in tree) return tree.children.some(treeUsesActorRule);
  if ("child" in tree) return treeUsesActorRule(tree.child);
  return (
    tree.op === "actor_not_creator" ||
    tree.op === "actor_is_creator" ||
    tree.op === "actor_not_prior_actor"
  );
}

/** Every state name an `actor_not_prior_actor` rule in the tree refers to. */
export function collectRuleStates(
  tree: TransitionConditionTree | null,
): string[] {
  if (tree === null) return [];
  if ("children" in tree) return tree.children.flatMap(collectRuleStates);
  if ("child" in tree) return collectRuleStates(tree.child);
  return tree.op === "actor_not_prior_actor" ? (tree.states ?? []) : [];
}

/** True when the tree contains a rule that needs the instance's prior actors loaded. */
export function treeNeedsPriorActors(
  tree: TransitionConditionTree | null,
): boolean {
  if (tree === null) return false;
  if ("children" in tree) return tree.children.some(treeNeedsPriorActors);
  if ("child" in tree) return treeNeedsPriorActors(tree.child);
  return tree.op === "actor_not_prior_actor";
}

function evaluateFieldCondition(
  cond: FieldCondition,
  fields: Record<string, unknown>,
): boolean {
  const value = fields[cond.field];

  switch (cond.op) {
    case "eq":
      return value === cond.value;
    case "neq":
      return value !== cond.value;
    case "gt":
      return (
        typeof value === "number" &&
        typeof cond.value === "number" &&
        value > cond.value
      );
    case "gte":
      return (
        typeof value === "number" &&
        typeof cond.value === "number" &&
        value >= cond.value
      );
    case "lt":
      return (
        typeof value === "number" &&
        typeof cond.value === "number" &&
        value < cond.value
      );
    case "lte":
      return (
        typeof value === "number" &&
        typeof cond.value === "number" &&
        value <= cond.value
      );
    case "contains":
      return (
        typeof value === "string" &&
        typeof cond.value === "string" &&
        value.includes(cond.value)
      );
    case "in":
      return Array.isArray(cond.value) && cond.value.includes(value);
    case "empty":
      return value === null || value === undefined || value === "";
    case "not_empty":
      return value !== null && value !== undefined && value !== "";
    default:
      return false;
  }
}
