// docs/specs/mandatory-ticket-fields.md R7: a rule that creates a ticket (create_entity) or a
// sub-task (create_child) carries a template with the four mandatory values. The engine fills
// any gap with the same defaults, so an older rule without a template keeps running; the
// rules list flags it "Needs template".

export type TicketSeverity = "critical" | "high" | "medium" | "low";

export const TICKET_SEVERITIES: TicketSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
];

export const DEFAULT_DUE_DAYS = 3;
export const DEFAULT_SEVERITY: TicketSeverity = "medium";
export const MAX_DUE_DAYS = 3650;

export interface TicketTemplate {
  title?: string | undefined;
  due_days?: number | undefined;
  remark?: string | undefined;
  severity?: TicketSeverity | undefined;
  assignedTo?: string | undefined;
  teamId?: string | undefined;
}

export function isTicketAction(type: string): boolean {
  return type === "create_entity" || type === "create_child";
}

export function templateOf(config: Record<string, unknown>): TicketTemplate {
  const t = config.template;
  // The API stores the template as validated JSON (automation-rules/schemas.ts); the form
  // only reads keys it checks below.
  return t && typeof t === "object" ? (t as TicketTemplate) : {};
}

/** A new create action starts from the engine's own defaults. */
export function defaultTemplate(): TicketTemplate {
  return { due_days: DEFAULT_DUE_DAYS, severity: DEFAULT_SEVERITY };
}

export function defaultRemark(ruleName: string): string {
  return `Created by automation: ${ruleName}`;
}

function blank(v: unknown): boolean {
  return typeof v !== "string" || v.trim() === "";
}

function validDueDays(v: unknown): boolean {
  return (
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_DUE_DAYS
  );
}

/** Why the wizard can't save this create action yet, or null. */
export function ticketActionProblem(
  type: string,
  config: Record<string, unknown>,
): string | null {
  if (type === "create_entity" && blank(config.entityTypeId)) {
    return "Pick the workflow the ticket is created in.";
  }
  const t = templateOf(config);
  if (!validDueDays(t.due_days)) {
    return `Due in must be a whole number of days, 0 to ${MAX_DUE_DAYS}.`;
  }
  if (!t.severity) return "Pick a severity.";
  if (t.assignedTo && t.teamId)
    return "Assign to a person or a team, not both.";
  return null;
}

/**
 * Fills the title and remark from the rule's name on save -- the name is entered after the
 * actions -- so a saved rule always carries all four. A sub-task's blank title is left to the
 * engine, which makes it "<rule>: <parent title>".
 */
export function completeTemplate(
  type: string,
  config: Record<string, unknown>,
  ruleName: string,
): Record<string, unknown> {
  const t = templateOf(config);
  const next: TicketTemplate = { ...t };
  if (type === "create_entity" && blank(t.title)) next.title = ruleName;
  if (blank(t.remark)) next.remark = defaultRemark(ruleName);
  if (blank(next.title)) delete next.title;
  if (blank(next.assignedTo)) delete next.assignedTo;
  if (blank(next.teamId)) delete next.teamId;
  return { ...config, template: next };
}

/** For the rules list: a create action whose template is missing a mandatory value. */
export function needsTemplate(
  actions: Array<{ type: string; config: Record<string, unknown> }>,
): boolean {
  return actions.some((a) => {
    if (!isTicketAction(a.type)) return false;
    const t = templateOf(a.config);
    return (
      !validDueDays(t.due_days) ||
      blank(t.remark) ||
      !t.severity ||
      (a.type === "create_entity" && blank(t.title))
    );
  });
}
