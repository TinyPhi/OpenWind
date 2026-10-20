import type { AuthContext } from "@platform/auth";
import { treeUsesActorRule } from "@platform/workflow-engine";
import { sameJson } from "./audit-workflow-access.js";

type ConditionTree = Parameters<typeof treeUsesActorRule>[0];

export class SodRuleForbiddenError extends Error {
  constructor() {
    super("Only an admin can add, change or remove an actor rule");
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
