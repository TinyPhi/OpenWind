/**
 * docs/specs/mandatory-ticket-fields.md R7: an automation-created ticket or sub-task always
 * carries the four mandatory values. A rule's template sets them; anything it leaves out
 * gets the owner's defaults (2026-10-16): due in 3 days, medium, the remark
 * "Created by automation: <rule>" and a title from the rule's name. The assignee is the
 * template's person or team, else the fallback owner, else nobody (unassigned is allowed,
 * owner decision 2026-10-19).
 *
 * The fallback assignee needs the tenant's admins, which only Zitadel knows; the worker
 * registers a resolver at startup (the same pattern as entity-engine's audit hook), since
 * this package can't call Zitadel.
 */
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { tenantUsers } from "@platform/db";
import { logger } from "@platform/logger";
import type { TicketTemplate } from "../types.js";

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

async function isTenantMember(
  db: DbOrTx,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(
      and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)),
    )
    .limit(1);
  return row !== undefined;
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
  let assignedTo = nonBlank(t.assignedTo) ?? nonBlank(input.legacyAssignee);
  // A rule keeps the assignee it was saved with; once they leave the tenant, the ticket goes
  // to the fallback owner instead.
  if (
    !teamId &&
    assignedTo &&
    !(await isTenantMember(db, tenantId, assignedTo))
  ) {
    logger.warn(
      { tenantId, workflowId: input.workflowId, ruleName: input.ruleName },
      "automation: the rule's assignee is no longer a tenant member; using the fallback",
    );
    assignedTo = undefined;
  }
  if (teamId) {
    values.teamId = teamId;
  } else if (assignedTo) {
    values.assignedTo = assignedTo;
  } else {
    const fallback = fallbackResolver
      ? await fallbackResolver(db, tenantId, input.workflowId)
      : null;
    if (fallback) values.assignedTo = fallback;
  }
  return values;
}
