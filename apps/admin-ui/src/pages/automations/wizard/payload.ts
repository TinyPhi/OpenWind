// Mapping between the wizard's editing state and the automation-rules API
// payload (#684). The API validates trigger and action config keys against
// apps/api/src/routes/automation-rules/schemas.ts, so these must match it.

import type { ActionItem, TriggerType } from "./types.js";

type HeaderRow = { key: string; value: string };

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
