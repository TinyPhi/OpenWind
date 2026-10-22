import { requireAuth } from "@platform/auth";
import { eq, inArray, and, desc } from "drizzle-orm";
import {
  withTenantContext,
  withTenantAndUserContext,
  entityInstances,
  entityTypes,
  workflows,
  savedViews,
  accessRequests,
} from "@platform/db";
import { isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { resolveUserScopedEntityIds } from "../entities/scoped-access.js";
import { logger } from "@platform/logger";
import type {
  PendingApprovalsSectionSchema,
  AdminWorkflowSchema,
  SavedViewSummarySchema,
} from "./schemas.js";
import type { z } from "zod";
import {
  DASHBOARD_SCOPE_LIMIT,
  LIST_CAP,
  buildScopedDashboardSections,
  deriveTitle,
} from "./view-builder.js";

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

// No requireRole() — intentional, not an oversight. Every section here is
// keyed off c.get("auth").userId (never a caller-supplied target user) and
// scoped to the caller's own tenant, so there is no role for which this
// route would need to be blocked (docs/specs/personal-dashboard.md R5:
// reachable by every authenticated role, admin through customer).
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

      const {
        workflows: workflowsBreakdown,
        tickets,
        dueDates,
        slaRisk,
      } = await buildScopedDashboardSections(tenantId, scopedIds, now, {
        tenantId,
        userId,
      });

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
