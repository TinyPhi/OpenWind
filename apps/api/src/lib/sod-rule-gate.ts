import type { AuthContext } from "@platform/auth";
import { treeUsesActorRule } from "@platform/workflow-engine";
import { sameJson, sameMembers } from "./audit-workflow-access.js";

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

/**
 * Throws unless the caller is a person admin, when a transition carries an actor rule and the write
 * changes its allowedRoles. Changing allowedRoles on a ruled transition touches department or role
 * gating for a segregation-of-duties control (#1132).
 */
export function assertMayModifyRuledRoles(
  auth: AuthContext,
  conditions: unknown,
  beforeRoles: readonly string[] | null | undefined,
  nextRoles: readonly string[] | null | undefined,
): void {
  if (isPersonAdmin(auth)) return;
  if (nextRoles === undefined) return;
  if (!usesActorRule(conditions)) return;
  if (sameMembers(beforeRoles, nextRoles)) return;
  throw new SodRuleForbiddenError(
    "Only an admin can change allowed roles on a transition with an actor rule",
  );
}

/**
 * Throws unless the caller is a person admin, when adding a transition between two states where
 * an existing transition already carries an actor rule. Adding an unruled transition alongside
 * an existing ruled transition creates a parallel unruled bypass edge around segregation-of-duties (#1132).
 */
export function assertMayAddTransitionOnEdge(
  auth: AuthContext,
  existingTransitionsOnEdge: Array<{ conditions: unknown }>,
  nextConditions: unknown,
): void {
  if (isPersonAdmin(auth)) return;
  assertMaySetActorRules(auth, null, nextConditions ?? null);
  const edgeHasRule = existingTransitionsOnEdge.some((t) =>
    usesActorRule(t.conditions),
  );
  if (edgeHasRule) {
    throw new SodRuleForbiddenError(
      "Only an admin can add an alternate transition between steps protected by an actor rule",
    );
  }
}
