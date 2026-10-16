/**
 * docs/specs/mandatory-ticket-fields.md R7: an automation-created ticket or sub-task always
 * carries all five mandatory values. A rule's template sets them; anything it leaves out
 * gets the owner's defaults (2026-10-16): due in 3 days, medium, the remark
 * "Created by automation: <rule>", a title from the rule's name, and the fallback assignee.
 *
 * The fallback assignee needs the tenant's admins, which only Zitadel knows; the worker
 * registers a resolver at startup (the same pattern as entity-engine's audit hook), since
 * this package can't call Zitadel.
 */
import type { DbOrTx } from "@platform/db";
import { AutomationError, type TicketTemplate } from "../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_AUTOMATION_DUE_DAYS = 3;

/** The workflow's creator, else its workflow admins, else the longest-standing tenant admin. */
export type FallbackAssigneeResolver = (
  db: DbOrTx,
  tenantId: string,
  workflowId: string | null,
) => Promise<string | null>;

let fallbackResolver: FallbackAssigneeResolver | null = null;

export function registerFallbackAssigneeResolver(
  resolver: FallbackAssigneeResolver | null,
): void {
  fallbackResolver = resolver;
}

export interface ResolvedTicketValues {
  title: string;
  dueDate: string;
  remark: string;
  severity: NonNullable<TicketTemplate["severity"]>;
  assignedTo?: string;
  teamId?: string;
}

function nonBlank(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export async function resolveTicketValues(
  db: DbOrTx,
  tenantId: string,
  input: {
    template: TicketTemplate | undefined;
    ruleName: string;
    /** A title the rule's static fields already set; wins over the default. */
    fieldsTitle: unknown;
    defaultTitle: string;
    /** The rule's older single-assignee setting, kept working. */
    legacyAssignee: string | null | undefined;
    workflowId: string | null;
    now?: Date;
  },
): Promise<ResolvedTicketValues> {
  const t = input.template ?? {};
  const now = input.now ?? new Date();
  // Seed SQL bypasses the API's validation: an unusable due_days falls back to the default.
  const dueDays =
    Number.isInteger(t.due_days) && (t.due_days ?? -1) >= 0
      ? (t.due_days as number)
      : DEFAULT_AUTOMATION_DUE_DAYS;

  const values: ResolvedTicketValues = {
    title:
      nonBlank(t.title) ?? nonBlank(input.fieldsTitle) ?? input.defaultTitle,
    dueDate: new Date(now.getTime() + dueDays * DAY_MS).toISOString(),
    remark: nonBlank(t.remark) ?? `Created by automation: ${input.ruleName}`,
    severity: t.severity ?? "medium",
  };

  const teamId = nonBlank(t.teamId);
  const assignedTo = nonBlank(t.assignedTo) ?? nonBlank(input.legacyAssignee);
  if (teamId) {
    values.teamId = teamId;
  } else if (assignedTo) {
    values.assignedTo = assignedTo;
  } else {
    const fallback = fallbackResolver
      ? await fallbackResolver(db, tenantId, input.workflowId)
      : null;
    if (!fallback) {
      // The execution is recorded as failed with this message; no ticket is created unassigned.
      const err = new AutomationError("NO_ASSIGNEE", {
        workflowId: input.workflowId,
      });
      err.message =
        "NO_ASSIGNEE: set an assignee in the rule's template, or give the workflow an owner";
      throw err;
    }
    values.assignedTo = fallback;
  }
  return values;
}
