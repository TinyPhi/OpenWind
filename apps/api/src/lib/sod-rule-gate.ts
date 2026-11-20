import type { AuthContext } from "@platform/auth";
import { treeUsesActorRule } from "@platform/workflow-engine";
import { sameJson } from "./audit-workflow-access.js";

type ConditionTree = Parameters<typeof treeUsesActorRule>[0];

export class SodRuleForbiddenError extends Error {
  constructor(
    message = "Only an admin can add, change or remove an actor rule",
  ) {
    super(message);
    this.name = "SodRuleForbiddenError";
  }
}

// A key can carry the admin scope, and a leaked or over-scoped one must not be able to lift a
// segregation-of-duties rule for someone else to exploit, so only a person counts.
export function isPersonAdmin(auth: AuthContext): boolean {
  return auth.roles.includes("admin") && !auth.userId.startsWith("apikey:");
}

export function usesActorRule(conditions: unknown): boolean {
  if (conditions === null || conditions === undefined) return false;
  try {
    // Stored jsonb is validated at write time by TransitionConditionsSchema, so it has the tree shape.
    return treeUsesActorRule(conditions as ConditionTree);
  } catch {
    return JSON.stringify(conditions).includes('"actor_');
  }
}

/**
 * Throws unless the caller is a person admin, when a transition write would add, change or remove
 * an actor rule. `next` is the incoming conditions, or `undefined` when the write leaves them alone
 * (a delete passes `null`). Re-sending the stored conditions unchanged is not a change.
 */
export function assertMaySetActorRules(
  auth: AuthContext,
  before: unknown,
  next: unknown,
): void {
  if (isPersonAdmin(auth)) return;
  if (next === undefined) return;
  const touchesRule = usesActorRule(before) || usesActorRule(next);
  if (!touchesRule) return;
  if (sameJson(before, next)) return;
  throw new SodRuleForbiddenError();
}

/** True when any of a workflow's transitions carries an `actor_*` condition. */
export function workflowCarriesActorRule(
  transitions: ReadonlyArray<{ conditions: unknown }>,
): boolean {
  return transitions.some((t) => usesActorRule(t.conditions));
}

/**
 * Throws unless the caller is a person admin, when the workflow carries an actor rule and the write
 * edits who may take a step: adding a transition, re-pointing one, or changing a transition's
 * allowedRoles or conditions. A segregation-of-duties rule only holds if the graph around it cannot
 * be rewired, so on such a workflow these edits are admin-only for every transition, not only the
 * ruled one (#1132). `transitions` is the workflow's transitions as they will survive the write.
 */
export function assertMayEditRuledWorkflow(
  auth: AuthContext,
  transitions: ReadonlyArray<{ conditions: unknown }>,
  action: string,
): void {
  if (isPersonAdmin(auth)) return;
  if (!workflowCarriesActorRule(transitions)) return;
  throw new SodRuleForbiddenError(
    `Only an admin can ${action} on a workflow that carries an actor rule`,
  );
}
