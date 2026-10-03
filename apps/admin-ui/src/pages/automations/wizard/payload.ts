// Mapping between the wizard's editing state and the automation-rules API
// payload (#684). The API validates trigger and action config keys against
// apps/api/src/routes/automation-rules/schemas.ts, so these must match it.

import type { ActionItem, TriggerType } from "./types.js";

type HeaderRow = { key: string; value: string };

const WIZARD_TRIGGERS: ReadonlySet<string> = new Set<TriggerType>([
  "workflow.entered_state",
  "workflow.transitioned",
  "workflow.sla_breached",
  "field.changed",
  "entity.created",
  "entity.assigned",
]);

// #684: "State entered" and "Field changed" are wizard choices, not API
// trigger types — nothing emits them. They save as the events that do fire.
export function toApiTrigger(
  choice: TriggerType,
  config: Record<string, unknown>,
): { triggerType: string; triggerConfig: Record<string, unknown> } {
  if (choice === "workflow.entered_state") {
    return { triggerType: "workflow.transitioned", triggerConfig: config };
  }
  if (choice === "field.changed") {
    return { triggerType: "entity.updated", triggerConfig: config };
  }
  return { triggerType: choice, triggerConfig: config };
}

// The reverse, for editing a stored rule. A transition rule narrowed only by
// destination state reads as "State entered". A stored type the wizard has
// no choice for (e.g. a rule disabled by migration 0132) opens unselected.
export function fromApiTrigger(
  triggerType: string,
  config: Record<string, unknown>,
): TriggerType | "" {
  if (
    triggerType === "workflow.transitioned" &&
    typeof config.toState === "string" &&
    config.fromState === undefined
  ) {
    return "workflow.entered_state";
  }
  if (triggerType === "entity.updated") return "field.changed";
  return WIZARD_TRIGGERS.has(triggerType) ? (triggerType as TriggerType) : "";
}

// The executor reads `state` for SLA breaches but `toState` for state entry.
export function stateKeyFor(
  triggerType: TriggerType | "",
): "state" | "toState" {
  return triggerType === "workflow.sla_breached" ? "state" : "toState";
}

// Placeholder options ("— any state —") carry "": drop the key rather than
// send an empty string the API's uuid/min(1) checks reject.
export function withConfigValues(
  config: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...config };
  for (const [key, value] of Object.entries(patch)) {
    if (value === "" || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

function isHeaderRows(value: unknown): value is HeaderRow[] {
  return Array.isArray(value);
}

function isHeaderRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The webhook editor keeps headers as rows so a half-typed row can exist;
// the API stores a { name: value } record.
export function toApiActions(
  actions: ActionItem[],
): Array<Omit<ActionItem, "id">> {
  return actions.map(({ id: _id, ...action }) => {
    if (action.type !== "webhook" || !isHeaderRows(action.config.headers)) {
      return action;
    }
    const headers = Object.fromEntries(
      action.config.headers
        .filter((h) => h.key.trim() !== "")
        .map((h) => [h.key.trim(), h.value]),
    );
    const { headers: _rows, ...rest } = action.config;
    return {
      ...action,
      config:
        Object.keys(headers).length > 0 ? { ...rest, headers } : { ...rest },
    };
  });
}

export function fromApiActions(
  actions: Array<Omit<ActionItem, "id">>,
  genId: () => string,
): ActionItem[] {
  return actions.map((action) => {
    const headers = action.config.headers;
    if (action.type !== "webhook" || !isHeaderRecord(headers)) {
      return { ...action, id: genId() };
    }
    return {
      ...action,
      id: genId(),
      config: {
        ...action.config,
        headers: Object.entries(headers).map(([key, value]) => ({
          key,
          value,
        })),
      },
    };
  });
}
