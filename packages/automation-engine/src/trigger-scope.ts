import type { TriggerEvent } from "./event-schemas.js";

/**
 * Resolves an entity type id to its name within the executing tenant, or null
 * if it doesn't exist there. Injected so ruleInScope stays pure.
 */
export type EntityTypeNameResolver = (
  entityTypeId: string,
) => Promise<string | null>;

// trigger_config key → the event field it is compared against, per trigger
// type (docs/specs/automation-trigger-config-scoping.md §I). `entityType` (a
// name, from module seeds) is handled separately.
const SCOPE_KEYS: Record<string, Record<string, string>> = {
  "workflow.transitioned": {
    workflowId: "workflowId",
    fromState: "fromState",
    toState: "toState",
    entityTypeId: "entityTypeId",
  },
  "workflow.sla_breached": {
    workflowId: "workflowId",
    state: "state",
    entityTypeId: "entityTypeId",
  },
  "entity.created": { entityTypeId: "entityTypeId" },
  "entity.assigned": { entityTypeId: "entityTypeId" },
  "entity.unassigned": { entityTypeId: "entityTypeId" },
  "entity.updated": { entityTypeId: "entityTypeId" },
  "entity.due_date_overdue": { entityTypeId: "entityTypeId" },
};

// uuids arrive lowercase in events but the API stores trigger_config as
// submitted, so id keys compare case-insensitively; state names stay exact.
const ID_KEYS = new Set(["workflowId", "entityTypeId"]);

function scopeValueMatches(
  key: string,
  expected: unknown,
  actual: unknown,
): boolean {
  if (
    ID_KEYS.has(key) &&
    typeof expected === "string" &&
    typeof actual === "string"
  ) {
    return expected.toLowerCase() === actual.toLowerCase();
  }
  return actual === expected;
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * True when `event` falls inside the scope `config` names. Missing, null and
 * "" values mean "any"; keys not defined for the trigger type are ignored. A
 * key that is set but whose event field is absent does not match — the event
 * can't be shown to be in scope.
 */
export async function ruleInScope(
  config: Record<string, unknown> | null | undefined,
  event: TriggerEvent,
  resolveEntityTypeName: EntityTypeNameResolver,
): Promise<boolean> {
  if (!config) return true;
  const keys = SCOPE_KEYS[event.eventType];
  if (!keys) return true;
  const fields = event as Record<string, unknown>;

  for (const [key, eventField] of Object.entries(keys)) {
    const expected = config[key];
    if (isUnset(expected)) continue;
    if (!scopeValueMatches(key, expected, fields[eventField])) return false;
  }

  const expectedName = config["entityType"];
  if (!isUnset(expectedName)) {
    const entityTypeId = fields["entityTypeId"];
    if (typeof entityTypeId !== "string") return false;
    if ((await resolveEntityTypeName(entityTypeId)) !== expectedName) {
      return false;
    }
  }
  return true;
}
