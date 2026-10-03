// How the automations list names a rule's trigger (#684).

const TRIGGER_LABELS: Record<string, string> = {
  "workflow.transitioned": "Transitioned",
  "workflow.sla_breached": "SLA breached",
  "entity.created": "Record created",
  "entity.assigned": "Record assigned",
  "entity.updated": "Record updated",
  "workflow.entered_state": "State entered",
  "field.changed": "Field changed",
  "schedule.cron": "Scheduled",
  "connector.event": "Connector event",
};

// The API no longer accepts these and refuses to re-enable rules stored with
// them; migration 0132 converted or disabled every such rule.
const RETIRED_TRIGGERS: ReadonlySet<string> = new Set([
  "workflow.entered_state",
  "field.changed",
  "schedule.cron",
  "connector.event",
]);

export function isRetiredTrigger(triggerType: string): boolean {
  return RETIRED_TRIGGERS.has(triggerType);
}

export function triggerLabel(
  triggerType: string,
  triggerConfig: Record<string, unknown> | undefined,
): string {
  if (
    triggerType === "entity.updated" &&
    typeof triggerConfig?.field === "string"
  ) {
    return "Field changed";
  }
  return TRIGGER_LABELS[triggerType] ?? triggerType;
}
