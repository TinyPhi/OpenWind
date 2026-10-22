import { eq, inArray, and } from "drizzle-orm";
import {
  withTenantContext,
  entityInstances,
  entityTypes,
  workflows,
  workflowStates,
} from "@platform/db";
import { logger } from "@platform/logger";
import type {
  DueDatesSectionSchema,
  SlaRiskSectionSchema,
  TicketsSectionSchema,
  WorkflowBreakdownSchema,
} from "./schemas.js";
import type { z } from "zod";

// Shared dashboard pipeline: fetch the scoped entity rows, resolve names, and build
// the workflow breakdown + the three degrading sections. My View (my-view.ts) and the
// org views (org-view.ts, team-member-view.ts; docs/specs/my-org-view.md) all call
// this unmodified -- they differ only in which ids they scope to.

// R7 -- bounds the core query for a user/team scoped to an unusually large number of
// tickets. Larger than my-tickets.ts's MY_TICKETS_LIMIT (100) because the dashboard
// only returns aggregate counts + capped lists, not full ticket rows.
export const DASHBOARD_SCOPE_LIMIT = 2000;
// R7 -- dueDates/slaRisk are capped independently of the scope limit above.
export const LIST_CAP = 20;
// v1.2 -- the flat "my tickets" list gets its own, slightly larger cap: unlike
// dueDates/slaRisk (which only cover a subset), this is meant to stand in for
// "all of my work" and 20 reads as too thin for that framing.
const TICKETS_LIST_CAP = 50;

type DueDatesSection = z.infer<typeof DueDatesSectionSchema>;
type SlaRiskSection = z.infer<typeof SlaRiskSectionSchema>;
type TicketsSection = z.infer<typeof TicketsSectionSchema>;
type WorkflowBreakdown = z.infer<typeof WorkflowBreakdownSchema>;

export interface ScopedRow {
  id: string;
  workflowId: string | null;
  entityTypeId: string;
  currentState: string;
  fields: Record<string, unknown>;
  dueDate: Date | null;
  updatedAt: Date;
  assignedTo: string | null;
}

export function deriveTitle(
  fields: Record<string, unknown>,
  id: string,
): string {
  const candidate = fields.title ?? fields.subject ?? fields.name;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : `Ticket ${id.slice(0, 8)}`;
}

// v1.2 — every scoped ticket, irrespective of workflow and irrespective of
// whether it has a due_date at all (unlike buildDueDatesSection below, which
// only covers the has-a-due-date subset). Sort: overdue first (worst/earliest
// first), then dated-not-overdue (soonest first), then undated last.
export function buildTicketsSection(
  rows: ScopedRow[],
  entityTypeNames: Map<string, string>,
  workflowNames: Map<string, string>,
  stateNames: Map<string, string>,
  now: Date,
  opts: { includeAssignee?: boolean } = {},
): TicketsSection {
  const bucket = (r: ScopedRow): 0 | 1 | 2 => {
    if (r.dueDate === null) return 2;
    return r.dueDate.getTime() < now.getTime() ? 0 : 1;
  };

  const sorted = [...rows].sort((a, b) => {
    const bucketDiff = bucket(a) - bucket(b);
    if (bucketDiff !== 0) return bucketDiff;
    if (a.dueDate === null || b.dueDate === null) return 0;
    return a.dueDate.getTime() - b.dueDate.getTime();
  });

  const items = sorted.slice(0, TICKETS_LIST_CAP).map((r) => ({
    entityId: r.id,
    entityTypeId: r.entityTypeId,
    entityTypeName: entityTypeNames.get(r.entityTypeId) ?? "",
    workflowId: r.workflowId,
    workflowName: r.workflowId
      ? (workflowNames.get(r.workflowId) ?? null)
      : null,
    stateName: r.workflowId
      ? (stateNames.get(`${r.workflowId}::${r.currentState}`) ?? r.currentState)
      : r.currentState,
    title: deriveTitle(r.fields, r.id),
    dueDate: r.dueDate ? r.dueDate.toISOString() : null,
    isOverdue: r.dueDate !== null && r.dueDate.getTime() < now.getTime(),
    // Only the org views carry the assignee; My View's response is unchanged.
    ...(opts.includeAssignee ? { assignedTo: r.assignedTo } : {}),
  }));

  return { items, totalQualifying: rows.length };
}

// R2 — computed from already-fetched rows; wrapped by the caller so a bug here
// degrades only this section (R8), never the workflow breakdown.
export function buildDueDatesSection(
  rows: ScopedRow[],
  entityTypeNames: Map<string, string>,
  now: Date,
): DueDatesSection {
  const withDueDate = rows.filter(
    (r): r is ScopedRow & { dueDate: Date } => r.dueDate !== null,
  );
  const sorted = [...withDueDate].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime(),
  );
  const items = sorted.slice(0, LIST_CAP).map((r) => ({
    entityId: r.id,
    entityTypeId: r.entityTypeId,
    entityTypeName: entityTypeNames.get(r.entityTypeId) ?? "",
    workflowId: r.workflowId,
    title: deriveTitle(r.fields, r.id),
    dueDate: r.dueDate.toISOString(),
    isOverdue: r.dueDate.getTime() < now.getTime(),
  }));
  return { items, totalQualifying: withDueDate.length };
}

// R3 — sla_hours is state-derived and ephemeral; never merged with due_date
// (§V). Only rows in a state that configures sla_hours are eligible.
export function buildSlaRiskSection(
  rows: ScopedRow[],
  entityTypeNames: Map<string, string>,
  slaHoursByWorkflowState: Map<string, number>,
  stateNames: Map<string, string>,
  now: Date,
): SlaRiskSection {
  const atRisk = rows
    .map((r) => {
      if (!r.workflowId) return null;
      const key = `${r.workflowId}::${r.currentState}`;
      const slaHours = slaHoursByWorkflowState.get(key);
      if (slaHours === undefined) return null;
      const hoursIn = (now.getTime() - r.updatedAt.getTime()) / 3_600_000;
      const hoursOver = hoursIn - slaHours;
      if (hoursOver <= 0) return null;
      return {
        entityId: r.id,
        entityTypeId: r.entityTypeId,
        entityTypeName: entityTypeNames.get(r.entityTypeId) ?? "",
        title: deriveTitle(r.fields, r.id),
        workflowId: r.workflowId,
        stateName: stateNames.get(key) ?? r.currentState,
        hoursOver,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const sorted = [...atRisk].sort((a, b) => b.hoursOver - a.hoursOver);
  return { items: sorted.slice(0, LIST_CAP), totalQualifying: atRisk.length };
}

// docs/specs/my-org-view.md R7 -- per-person roster: tickets assigned to each member
// and how many of those are overdue. One row per member id, in the order given.
export function buildTeamMembersSection(
  rows: ScopedRow[],
  memberIds: string[],
  now: Date,
): Array<{ userId: string; ticketCount: number; overdueCount: number }> {
  return memberIds.map((userId) => {
    const owned = rows.filter((r) => r.assignedTo === userId);
    const overdueCount = owned.filter(
      (r) => r.dueDate !== null && r.dueDate.getTime() < now.getTime(),
    ).length;
    return { userId, ticketCount: owned.length, overdueCount };
  });
}

export interface ScopedDashboardSections {
  rows: ScopedRow[];
  workflows: WorkflowBreakdown[];
  tickets: TicketsSection;
  dueDates: DueDatesSection;
  slaRisk: SlaRiskSection;
}

/**
 * Everything My View returns that depends on the ticket ids: rows, workflow breakdown and
 * the tickets/dueDates/slaRisk sections. Callers handle the empty-ids case themselves.
 * `logContext` is attached to section-failure logs (tenantId, userId, ...).
 */
export async function buildScopedDashboardSections(
  tenantId: string,
  scopedIds: string[],
  now: Date,
  logContext: Record<string, unknown>,
  opts: { includeAssignee?: boolean } = {},
): Promise<ScopedDashboardSections> {
  const rawRows = await withTenantContext(tenantId, (tx) =>
    tx
      .select({
        id: entityInstances.id,
        workflowId: entityInstances.workflowId,
        entityTypeId: entityInstances.entityTypeId,
        currentState: entityInstances.currentState,
        fields: entityInstances.fields,
        dueDate: entityInstances.dueDate,
        updatedAt: entityInstances.updatedAt,
        assignedTo: entityInstances.assignedTo,
      })
      .from(entityInstances)
      .where(
        and(
          eq(entityInstances.tenantId, tenantId),
          inArray(entityInstances.id, scopedIds),
        ),
      ),
  );
  // jsonb columns come back as `unknown` from Drizzle — fields is always a
  // JSON object (default '{}'), same assumption my-tickets.ts makes.
  const rows: ScopedRow[] = rawRows.map((r) => ({
    ...r,
    fields: r.fields as Record<string, unknown>,
  }));

  const wfIds = [
    ...new Set(rows.map((r) => r.workflowId).filter(Boolean)),
  ] as string[];
  const entityTypeIds = [...new Set(rows.map((r) => r.entityTypeId))];

  const [workflowRows, stateRows, entityTypeRows] =
    wfIds.length > 0
      ? await Promise.all([
          withTenantContext(tenantId, (tx) =>
            tx
              .select({ id: workflows.id, name: workflows.name })
              .from(workflows)
              .where(
                and(
                  eq(workflows.tenantId, tenantId),
                  inArray(workflows.id, wfIds),
                ),
              ),
          ),
          withTenantContext(tenantId, (tx) =>
            tx
              .select({
                workflowId: workflowStates.workflowId,
                name: workflowStates.name,
                label: workflowStates.label,
                slaHours: workflowStates.slaHours,
              })
              .from(workflowStates)
              .where(
                and(
                  eq(workflowStates.tenantId, tenantId),
                  inArray(workflowStates.workflowId, wfIds),
                ),
              ),
          ),
          withTenantContext(tenantId, (tx) =>
            tx
              .select({ id: entityTypes.id, name: entityTypes.name })
              .from(entityTypes)
              .where(inArray(entityTypes.id, entityTypeIds)),
          ),
        ])
      : [
          [],
          [],
          await withTenantContext(tenantId, (tx) =>
            tx
              .select({ id: entityTypes.id, name: entityTypes.name })
              .from(entityTypes)
              .where(inArray(entityTypes.id, entityTypeIds)),
          ),
        ];

  const workflowNames = new Map(workflowRows.map((w) => [w.id, w.name]));
  const entityTypeNames = new Map(entityTypeRows.map((et) => [et.id, et.name]));
  const stateNames = new Map(
    stateRows.map((s) => [`${s.workflowId}::${s.name}`, s.label]),
  );
  const slaHoursByWorkflowState = new Map(
    stateRows
      .filter((s) => s.slaHours !== null)
      .map((s) => [`${s.workflowId}::${s.name}`, s.slaHours as number]),
  );

  // ── R1: per-workflow, per-state counts — empty workflows omitted ────────
  const countsByWorkflow = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.workflowId) continue;
    const stateCounts =
      countsByWorkflow.get(r.workflowId) ?? new Map<string, number>();
    stateCounts.set(r.currentState, (stateCounts.get(r.currentState) ?? 0) + 1);
    countsByWorkflow.set(r.workflowId, stateCounts);
  }

  const workflowsBreakdown = [...countsByWorkflow.entries()].map(
    ([workflowId, stateCounts]) => {
      const counts = [...stateCounts.entries()].map(([stateId, count]) => ({
        stateId,
        stateName: stateNames.get(`${workflowId}::${stateId}`) ?? stateId,
        count,
      }));
      return {
        workflowId,
        workflowName: workflowNames.get(workflowId) ?? workflowId,
        counts,
        total: counts.reduce((sum, cnt) => sum + cnt.count, 0),
      };
    },
  );

  // ── v1.2: flat "my tickets" section degrades independently on failure ───
  let tickets: TicketsSection;
  try {
    tickets = buildTicketsSection(
      rows,
      entityTypeNames,
      workflowNames,
      stateNames,
      now,
      opts,
    );
  } catch (err) {
    logger.error({ err, ...logContext }, "dashboard: tickets section failed");
    tickets = { items: [], totalQualifying: 0, unavailable: true };
  }

  // ── R2/R8: due-date section degrades independently on failure ───────────
  let dueDates: DueDatesSection;
  try {
    dueDates = buildDueDatesSection(rows, entityTypeNames, now);
  } catch (err) {
    logger.error({ err, ...logContext }, "dashboard: dueDates section failed");
    dueDates = { items: [], totalQualifying: 0, unavailable: true };
  }

  // ── R3/R8: SLA-risk section degrades independently on failure ───────────
  let slaRisk: SlaRiskSection;
  try {
    slaRisk = buildSlaRiskSection(
      rows,
      entityTypeNames,
      slaHoursByWorkflowState,
      stateNames,
      now,
    );
  } catch (err) {
    logger.error({ err, ...logContext }, "dashboard: slaRisk section failed");
    slaRisk = { items: [], totalQualifying: 0, unavailable: true };
  }
  return {
    rows,
    workflows: workflowsBreakdown,
    tickets,
    dueDates,
    slaRisk,
  };
}
