import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { eq, and, isNull, or, sql, desc, inArray, asc } from "drizzle-orm";
import { requireAuth } from "@platform/auth";
import {
  withTenantContext,
  entityInstances,
  entityRelations,
  workflows,
  workflowStates,
  workflowTransitions,
} from "@platform/db";
import { MAX_PAGE_SIZE } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

// M-1: hard cap on the primary query — this endpoint aggregates across
// parents/children/workflow-summary rather than a single cursor-paginated
// list, so a full cursor implementation is a larger change; this bounds the
// worst case (a senior agent mass-mentioned tenant-wide) instead.
const MY_TICKETS_LIMIT = MAX_PAGE_SIZE;

type AccessReason = "creator" | "assigned" | "mention" | "manual";

const MyTicketsQuerySchema = z.object({
  workflowId: z.string().uuid().optional(),
});

function deriveAccessReason(
  userId: string,
  createdBy: string | null,
  assignedTo: string | null,
  accessMap: Record<string, { level: string; tag: string }>,
): AccessReason {
  if (createdBy === userId) return "creator";
  if (assignedTo === userId) return "assigned";
  const entry = accessMap[userId];
  if (entry?.tag === "mention") return "mention";
  return "manual";
}

function parseAccessMap(
  raw: unknown,
): Record<string, { level: string; tag: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, { level: string; tag: string }>;
}

function toWorkflowSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export const myTicketsHandler = factory.createHandlers(
  requireAuth(),
  zValidator("query", MyTicketsQuerySchema),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const { workflowId } = c.req.valid("query");

    try {
      // ── Step 1: find all instances where user is in the access list ───────
      // Three access vectors: created_by, assigned_to, __accessUsers JSONB key
      const accessFilter = or(
        eq(entityInstances.createdBy, userId),
        eq(entityInstances.assignedTo, userId),
        sql`${entityInstances.fields}->'__accessUsers' ? ${userId}`,
      );

      const baseConditions = and(
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
        accessFilter,
        workflowId ? eq(entityInstances.workflowId, workflowId) : undefined,
      );

      const fetchedRows = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            id: entityInstances.id,
            workflowId: entityInstances.workflowId,
            currentState: entityInstances.currentState,
            fields: entityInstances.fields,
            assignedTo: entityInstances.assignedTo,
            createdBy: entityInstances.createdBy,
            createdAt: entityInstances.createdAt,
          })
          .from(entityInstances)
          .where(baseConditions)
          .orderBy(desc(entityInstances.createdAt))
          .limit(MY_TICKETS_LIMIT + 1),
      );

      const hasMore = fetchedRows.length > MY_TICKETS_LIMIT;
      const accessibleRows = hasMore
        ? fetchedRows.slice(0, MY_TICKETS_LIMIT)
        : fetchedRows;

      if (accessibleRows.length === 0) {
        return c.json({
          data: { workflows: [], parentTickets: [], childTickets: [], hasMore },
        });
      }

      const accessibleIds = accessibleRows.map((r) => r.id);

      // ── Step 2: find which of these are children (have a child_of relation) ──
      const childRelations = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            fromInstanceId: entityRelations.fromInstanceId,
            toInstanceId: entityRelations.toInstanceId, // parent id
          })
          .from(entityRelations)
          .where(
            and(
              eq(entityRelations.tenantId, tenantId),
              sql`${entityRelations.fromInstanceId} = ANY(ARRAY[${sql.join(
                accessibleIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )}])`,
              eq(entityRelations.relationType, "child_of"),
              isNull(entityRelations.deletedAt),
            ),
          ),
      );

      const childToParentMap = new Map(
        childRelations.map((r) => [r.fromInstanceId, r.toInstanceId]),
      );
      const childInstanceIds = new Set(childToParentMap.keys());

      // ── Step 3: fetch parent rows for state placement of children ──────────
      const parentIdsNeeded = [
        ...new Set(childRelations.map((r) => r.toInstanceId)),
      ];
      const parentStateMap = new Map<string, string | null>();

      if (parentIdsNeeded.length > 0) {
        const parentRows = await withTenantContext(tenantId, (tx) =>
          tx
            .select({
              id: entityInstances.id,
              currentState: entityInstances.currentState,
              deletedAt: entityInstances.deletedAt,
            })
            .from(entityInstances)
            .where(
              and(
                eq(entityInstances.tenantId, tenantId),
                sql`${entityInstances.id} = ANY(ARRAY[${sql.join(
                  parentIdsNeeded.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )}])`,
              ),
            ),
        );
        for (const p of parentRows) {
          // Null deletedAt means parent is active; archived parents get null state
          parentStateMap.set(p.id, p.deletedAt ? null : p.currentState);
        }
      }

      // ── Step 4: collect unique workflowIds and fetch workflow metadata ─────
      // Includes entityTypeId + states/transition counts, not just id/name, so
      // the records page can render the same card (icon, state chips) for a
      // plain "user" caller as it does for admins — the card previously only
      // had a title and count because this endpoint returned bare id/name.
      const wfIds = [
        ...new Set(accessibleRows.map((r) => r.workflowId).filter(Boolean)),
      ] as string[];
      const [workflowRows, stateRows, transitionRows] =
        wfIds.length > 0
          ? await Promise.all([
              withTenantContext(tenantId, (tx) =>
                tx
                  .select({
                    id: workflows.id,
                    name: workflows.name,
                    entityTypeId: workflows.entityTypeId,
                  })
                  .from(workflows)
                  .where(inArray(workflows.id, wfIds)),
              ),
              withTenantContext(tenantId, (tx) =>
                tx
                  .select({
                    workflowId: workflowStates.workflowId,
                    name: workflowStates.name,
                    label: workflowStates.label,
                    color: workflowStates.color,
                    isTerminal: workflowStates.isTerminal,
                  })
                  .from(workflowStates)
                  .where(inArray(workflowStates.workflowId, wfIds))
                  .orderBy(
                    asc(workflowStates.sortOrder),
                    asc(workflowStates.id),
                  ),
              ),
              withTenantContext(tenantId, (tx) =>
                tx
                  .select({ workflowId: workflowTransitions.workflowId })
                  .from(workflowTransitions)
                  .where(inArray(workflowTransitions.workflowId, wfIds)),
              ),
            ])
          : [[], [], []];
      const workflowMeta = new Map(
        workflowRows.map((w) => [
          w.id,
          { name: w.name, entityTypeId: w.entityTypeId },
        ]),
      );
      const statesByWorkflow = new Map<string, (typeof stateRows)[number][]>();
      for (const s of stateRows) {
        if (!statesByWorkflow.has(s.workflowId)) {
          statesByWorkflow.set(s.workflowId, []);
        }
        statesByWorkflow.get(s.workflowId)?.push(s);
      }
      const transitionCountByWorkflow = new Map<string, number>();
      for (const t of transitionRows) {
        transitionCountByWorkflow.set(
          t.workflowId,
          (transitionCountByWorkflow.get(t.workflowId) ?? 0) + 1,
        );
      }

      // ── Step 5: split into parents and children, compute access reasons ────
      const parentTickets = [];
      const childTickets = [];
      const workflowCounts = new Map<string, number>();

      for (const row of accessibleRows) {
        const rawFields = row.fields as Record<string, unknown>;
        const accessMap = parseAccessMap(rawFields.__accessUsers);
        const reason = deriveAccessReason(
          userId,
          row.createdBy,
          row.assignedTo,
          accessMap,
        );
        const wfId = row.workflowId ?? "";

        // M-2: __accessUsers is the full ACL map for the ticket (which other
        // user IDs have access, at what level) — a side-channel this endpoint
        // shouldn't expose by default. getAccessHandler is the explicitly
        // gated route for that; strip it (and any other __-prefixed internal
        // field) before returning.
        const { __accessUsers: _accessUsers, ...publicFields } = rawFields;
        const fields = Object.fromEntries(
          Object.entries(publicFields).filter(([k]) => !k.startsWith("__")),
        );

        if (childInstanceIds.has(row.id)) {
          // Child ticket
          const parentId = childToParentMap.get(row.id);
          if (!parentId) continue;
          const parentCurrentState = parentStateMap.get(parentId) ?? null;

          // Skip children of archived parents (null state means archived)
          if (parentCurrentState === null && parentStateMap.has(parentId))
            continue;

          childTickets.push({
            id: row.id,
            parentId,
            parentCurrentState,
            workflowId: wfId,
            fields,
            assignedTo: row.assignedTo,
            createdAt: row.createdAt.toISOString(),
            accessReason: reason === "creator" ? ("manual" as const) : reason,
          });
        } else {
          // Parent ticket
          parentTickets.push({
            id: row.id,
            workflowId: wfId,
            currentState: row.currentState,
            fields,
            assignedTo: row.assignedTo,
            createdAt: row.createdAt.toISOString(),
            accessReason: reason,
          });
        }

        if (wfId) {
          workflowCounts.set(wfId, (workflowCounts.get(wfId) ?? 0) + 1);
        }
      }

      // ── Step 6: build workflow summary ─────────────────────────────────────
      const workflowSummaries = [...workflowCounts.entries()]
        .map(([wfId, count]) => {
          const meta = workflowMeta.get(wfId);
          const name = meta?.name ?? wfId;
          return {
            workflowId: wfId,
            workflowName: name,
            workflowSlug: toWorkflowSlug(name),
            entityTypeId: meta?.entityTypeId ?? "",
            accessibleTicketCount: count,
            states: statesByWorkflow.get(wfId) ?? [],
            transitionCount: transitionCountByWorkflow.get(wfId) ?? 0,
          };
        })
        .sort((a, b) => a.workflowName.localeCompare(b.workflowName));

      return c.json({
        data: {
          workflows: workflowSummaries,
          parentTickets,
          childTickets,
          hasMore,
        },
      });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
