import { requireAuth } from "@platform/auth";
import { getSubtreeMembers } from "@platform/org-directory";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { resolveUserScopedEntityIds } from "../entities/scoped-access.js";
import {
  DASHBOARD_SCOPE_LIMIT,
  buildScopedDashboardSections,
  buildTeamMembersSection,
} from "./view-builder.js";

// My Org View (docs/specs/my-org-view.md). The caller's own tickets plus every direct and
// indirect report's, using the same ticket predicate My View uses (scoped-access.ts) -- only
// the id list grows to [me, ...subtree]. The subtree comes from the org-directory tree.
//
// R5/§V (non-negotiable): the target user is ALWAYS c.get("auth").userId, never a query or
// body param. This route has no way to ask for anyone else's org view.
//
// R3: a separate route with its own try/catch, so nothing here can break GET /dashboard/my-view.
const EMPTY_SECTIONS = {
  workflows: [],
  tickets: { items: [], totalQualifying: 0 },
  dueDates: { items: [], totalQualifying: 0 },
  slaRisk: { items: [], totalQualifying: 0 },
};

export const orgViewHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const { tenantId, userId, displayName } = c.get("auth");
    const now = new Date();

    try {
      const { ids: memberIds, members } = await getSubtreeMembers(
        tenantId,
        userId,
      );

      // R1: no reports (or not in the tree yet) -> the frontend hides the toggle.
      if (memberIds.length === 0) {
        return c.json({
          data: {
            hasReports: false,
            ...EMPTY_SECTIONS,
            teamMembers: { items: [] },
          },
        });
      }

      const nameByUserId = new Map<string, string>(
        members.map((m) => [m.userId, m.name]),
      );
      nameByUserId.set(userId, displayName);

      const scopedIds = await resolveUserScopedEntityIds(
        tenantId,
        [userId, ...memberIds],
        { limit: DASHBOARD_SCOPE_LIMIT },
      );

      if (scopedIds.length === 0) {
        return c.json({
          data: {
            hasReports: true,
            ...EMPTY_SECTIONS,
            teamMembers: {
              items: memberIds.map((id) => ({
                userId: id,
                name: nameByUserId.get(id) ?? id,
                ticketCount: 0,
                overdueCount: 0,
              })),
            },
          },
        });
      }

      const { rows, ...sections } = await buildScopedDashboardSections(
        tenantId,
        scopedIds,
        now,
        { tenantId, userId },
        { includeAssignee: true },
      );

      const teamMembers = {
        items: buildTeamMembersSection(rows, memberIds, now).map((m) => ({
          ...m,
          name: nameByUserId.get(m.userId) ?? m.userId,
        })),
      };

      // An assignee outside the caller's subtree (a ticket a report created or was shared
      // on) is neither named nor identified: only people the caller can already see in
      // the tree are exposed.
      const tickets = {
        ...sections.tickets,
        items: sections.tickets.items.map((t) => {
          const known = t.assignedTo ? nameByUserId.has(t.assignedTo) : false;
          return {
            ...t,
            assignedTo: known ? t.assignedTo : null,
            assignedToName:
              known && t.assignedTo
                ? (nameByUserId.get(t.assignedTo) ?? null)
                : null,
          };
        }),
      };

      return c.json({
        data: { hasReports: true, ...sections, tickets, teamMembers },
      });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
