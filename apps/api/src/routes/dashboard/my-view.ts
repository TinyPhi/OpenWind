import { requireAuth } from "@platform/auth";
import { eq, inArray, and, desc } from "drizzle-orm";
import {
  withTenantContext,
  withTenantAndUserContext,
  entityInstances,
  entityTypes,
  workflows,
  workflowStates,
  savedViews,
  accessRequests,
} from "@platform/db";
import { isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { resolveUserScopedEntityIds } from "../entities/scoped-access.js";
import { logger } from "@platform/logger";
import type {
  DueDatesSectionSchema,
  SlaRiskSectionSchema,
  PendingApprovalsSectionSchema,
  AdminWorkflowSchema,
  SavedViewSummarySchema,
  TicketsSectionSchema,
} from "./schemas.js";
import type { z } from "zod";

// R7 — bounds the core query for a user scoped to an unusually large number of
// tickets. Larger than my-tickets.ts's MY_TICKETS_LIMIT (100) because this
// endpoint only returns aggregate counts + capped lists, not full ticket rows.
const DASHBOARD_SCOPE_LIMIT = 2000;
// R7 — dueDates/slaRisk are capped independently of the scope limit above.
const LIST_CAP = 20;
// v1.2 — the flat "my tickets" list gets its own, slightly larger cap: unlike
// dueDates/slaRisk (which only cover a subset), this is meant to stand in for
// "all of my work" and 20 reads as too thin for that framing.
const TICKETS_LIST_CAP = 50;

type DueDatesSection = z.infer<typeof DueDatesSectionSchema>;
type SlaRiskSection = z.infer<typeof SlaRiskSectionSchema>;
type TicketsSection = z.infer<typeof TicketsSectionSchema>;

interface ScopedRow {
  id: string;
  workflowId: string | null;
  entityTypeId: string;
  currentState: string;
  fields: Record<string, unknown>;
  dueDate: Date | null;
  updatedAt: Date;
}

function deriveTitle(fields: Record<string, unknown>, id: string): string {
  const candidate = fields.title ?? fields.subject ?? fields.name;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : `Ticket ${id.slice(0, 8)}`;
}

// v1.2 — every scoped ticket, irrespective of workflow and irrespective of
// whether it has a due_date at all (unlike buildDueDatesSection below, which
// only covers the has-a-due-date subset). Sort: overdue first (worst/earliest
// first), then dated-not-overdue (soonest first), then undated last.
function buildTicketsSection(
  rows: ScopedRow[],
  entityTypeNames: Map<string, string>,
  workflowNames: Map<string, string>,
  stateNames: Map<string, string>,
  now: Date,
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
  }));

  return { items, totalQualifying: rows.length };
}

// R2 — computed from already-fetched rows; wrapped by the caller so a bug here
// degrades only this section (R8), never the workflow breakdown.
function buildDueDatesSection(
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
function buildSlaRiskSection(
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

type AdminWorkflow = z.infer<typeof AdminWorkflowSchema>;
type SavedViewSummary = z.infer<typeof SavedViewSummarySchema>;
type PendingApprovalsSection = z.infer<typeof PendingApprovalsSectionSchema>;

// R10 — independent of ticket-scoping (resolveUserScopedEntityIds): a user can
// administer workflows without having any tickets of their own. tenant-scoped
// only; system-template workflows (tenantId null) are never "administered" by
// a tenant user, so this intentionally does not use workflows' visibleTo() OR.
async function fetchAdminWorkflows(
  tenantId: string,
  userId: string,
): Promise<AdminWorkflow[]> {
  const rows = await withTenantContext(tenantId, (tx) =>
    tx
      .select({
        id: workflows.id,
        name: workflows.name,
        entityTypeId: workflows.entityTypeId,
        createdBy: workflows.createdBy,
        assignedTo: workflows.assignedTo,
      })
      .from(workflows)
      .where(eq(workflows.tenantId, tenantId)),
  );
  return rows
    .filter((w) =>
      isWorkflowAdmin(userId, {
        createdBy: w.createdBy,
        assignedTo: w.assignedTo ?? [],
      }),
    )
    .map((w) => ({
      workflowId: w.id,
      workflowName: w.name,
      entityTypeId: w.entityTypeId,
    }));
}

// R11 — saved_views has a dual tenant+user RLS policy (db-conventions.md), so
// this must go through withTenantAndUserContext, not withTenantContext.
async function fetchSavedViews(
  tenantId: string,
  userId: string,
): Promise<SavedViewSummary[]> {
  const rows = await withTenantAndUserContext(tenantId, userId, (tx) =>
    tx
      .select({
        id: savedViews.id,
        name: savedViews.name,
        entityTypeId: savedViews.entityTypeId,
        entityTypeName: entityTypes.name,
      })
      .from(savedViews)
      .innerJoin(entityTypes, eq(savedViews.entityTypeId, entityTypes.id))
      .where(
        and(eq(savedViews.tenantId, tenantId), eq(savedViews.userId, userId)),
      ),
  );
  return rows;
}

// R12 — reuses isWorkflowAdmin's *result* (adminWorkflowIds), not a parallel
// authorization check (§V). Skips the query entirely when the caller
// administers nothing — an empty IN() would either error or full-scan.
async function fetchPendingApprovals(
  tenantId: string,
  adminWorkflowIds: string[],
): Promise<PendingApprovalsSection> {
  if (adminWorkflowIds.length === 0) {
    return { items: [], totalQualifying: 0 };
  }

  const rows = await withTenantContext(tenantId, (tx) =>
    tx
      .select({
        requestId: accessRequests.id,
        entityId: entityInstances.id,
        entityTypeId: entityInstances.entityTypeId,
        entityTypeName: entityTypes.name,
        fields: entityInstances.fields,
        workflowId: entityInstances.workflowId,
        workflowName: workflows.name,
        requesterId: accessRequests.requesterId,
        requestedLevel: accessRequests.requestedLevel,
        createdAt: accessRequests.createdAt,
      })
      .from(accessRequests)
      .innerJoin(
        entityInstances,
        eq(accessRequests.instanceId, entityInstances.id),
      )
      .innerJoin(entityTypes, eq(entityInstances.entityTypeId, entityTypes.id))
      .innerJoin(workflows, eq(entityInstances.workflowId, workflows.id))
      .where(
        and(
          eq(accessRequests.tenantId, tenantId),
          eq(accessRequests.status, "pending"),
          inArray(entityInstances.workflowId, adminWorkflowIds),
        ),
      )
      .orderBy(desc(accessRequests.createdAt)),
  );

  const items = rows.slice(0, LIST_CAP).map((r) => ({
    requestId: r.requestId,
    entityId: r.entityId,
    entityTypeId: r.entityTypeId,
    entityTypeName: r.entityTypeName,
    title: deriveTitle(r.fields as Record<string, unknown>, r.entityId),
    requesterId: r.requesterId,
    workflowId: r.workflowId as string,
    workflowName: r.workflowName,
    requestedLevel: r.requestedLevel,
    createdAt: r.createdAt.toISOString(),
  }));

  return { items, totalQualifying: rows.length };
}

export const myViewHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const now = new Date();

    try {
      // ── v1.1 sections (R10-R12) — independent of ticket-scoping below: a
      // user can administer workflows / have saved views / have pending
      // approvals with zero tickets of their own, so these must not be
      // skipped by the scopedIds-empty early return.
      let adminWorkflows: AdminWorkflow[] = [];
      try {
        adminWorkflows = await fetchAdminWorkflows(tenantId, userId);
      } catch (err) {
        logger.error(
          { err, tenantId, userId },
          "dashboard: adminWorkflows section failed",
        );
      }

      let savedViewsSection: SavedViewSummary[] = [];
      try {
        savedViewsSection = await fetchSavedViews(tenantId, userId);
      } catch (err) {
        logger.error(
          { err, tenantId, userId },
          "dashboard: savedViews section failed",
        );
      }

      let pendingApprovals: PendingApprovalsSection;
      try {
        pendingApprovals = await fetchPendingApprovals(
          tenantId,
          adminWorkflows.map((w) => w.workflowId),
        );
      } catch (err) {
        logger.error(
          { err, tenantId, userId },
          "dashboard: pendingApprovals section failed",
        );
        pendingApprovals = { items: [], totalQualifying: 0, unavailable: true };
      }

      // ── Core (R1) — must succeed, or the whole request fails ────────────────
      const scopedIds = await resolveUserScopedEntityIds(tenantId, [userId], {
        limit: DASHBOARD_SCOPE_LIMIT,
      });

      if (scopedIds.length === 0) {
        return c.json({
          data: {
            workflows: [],
            tickets: { items: [], totalQualifying: 0 },
            dueDates: { items: [], totalQualifying: 0 },
            slaRisk: { items: [], totalQualifying: 0 },
            adminWorkflows,
            savedViews: savedViewsSection,
            pendingApprovals,
          },
        });
      }

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
                  .where(inArray(workflows.id, wfIds)),
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
                  .where(inArray(workflowStates.workflowId, wfIds)),
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
      const entityTypeNames = new Map(
        entityTypeRows.map((et) => [et.id, et.name]),
      );
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
        stateCounts.set(
          r.currentState,
          (stateCounts.get(r.currentState) ?? 0) + 1,
        );
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
        );
      } catch (err) {
        logger.error(
          { err, tenantId, userId },
          "dashboard: tickets section failed",
        );
        tickets = { items: [], totalQualifying: 0, unavailable: true };
      }

      // ── R2/R8: due-date section degrades independently on failure ───────────
      let dueDates: DueDatesSection;
      try {
        dueDates = buildDueDatesSection(rows, entityTypeNames, now);
      } catch (err) {
        logger.error(
          { err, tenantId, userId },
          "dashboard: dueDates section failed",
        );
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
        logger.error(
          { err, tenantId, userId },
          "dashboard: slaRisk section failed",
        );
        slaRisk = { items: [], totalQualifying: 0, unavailable: true };
      }

      return c.json({
        data: {
          workflows: workflowsBreakdown,
          tickets,
          dueDates,
          slaRisk,
          adminWorkflows,
          savedViews: savedViewsSection,
          pendingApprovals,
        },
      });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
