import { z } from "zod";
import { requireAuth } from "@platform/auth";
import { getSubtreeMembers } from "@platform/org-directory";
import { factory } from "./factory.js";
import { zValidator } from "../../lib/validator.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { resolveUserScopedEntityIds } from "../entities/scoped-access.js";
import {
  DASHBOARD_SCOPE_LIMIT,
  boundDashboardScope,
  buildScopedDashboardSections,
} from "./view-builder.js";

// "View as subordinate" (docs/specs/my-org-view.md R9): a manager sees a report's own
// dashboard, read-only -- the same ticket pipeline My View uses, pointed at :userId.
//
// §V (non-negotiable): :userId comes from the URL but is never trusted. It must be in the
// caller's org subtree, checked against the tree on EVERY request. Anything else -- not in the
// subtree, the caller themself, unknown, or another tenant's user (the tree is read by the
// caller's own tenant, so it can't contain one) -- is the same 404, never a 403.
//
// Only the ticket sections are returned. adminWorkflows/savedViews/pendingApprovals are
// personal-workspace items with no team-visibility justification, so they are always empty.
const ParamSchema = z.object({ userId: z.string().min(1).max(200) });

const NOT_FOUND = { error: "NOT_FOUND", message: "User not found" } as const;

export const teamMemberViewHandler = factory.createHandlers(
  requireAuth(),
  zValidator("param", ParamSchema),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const { userId: targetUserId } = c.req.valid("param");
    const now = new Date();

    try {
      const { members } = await getSubtreeMembers(tenantId, userId);
      const target = members.find((m) => m.userId === targetUserId);
      if (!target) {
        return c.json(NOT_FOUND, 404);
      }

      const personal = {
        adminWorkflows: [],
        savedViews: [],
        pendingApprovals: { items: [], totalQualifying: 0 },
      };
      const targetUser = { userId: targetUserId, name: target.name };

      const resolvedIds = await resolveUserScopedEntityIds(
        tenantId,
        [targetUserId],
        { limit: DASHBOARD_SCOPE_LIMIT + 1 },
      );
      const { ids: scopedIds, truncated } = boundDashboardScope(resolvedIds);

      if (scopedIds.length === 0) {
        return c.json({
          data: {
            targetUser,
            truncated,
            workflows: [],
            tickets: { items: [], totalQualifying: 0 },
            dueDates: { items: [], totalQualifying: 0 },
            slaRisk: { items: [], totalQualifying: 0 },
            ...personal,
          },
        });
      }

      const { workflows, tickets, dueDates, slaRisk } =
        await buildScopedDashboardSections(tenantId, scopedIds, now, {
          tenantId,
          userId,
          targetUserId,
        });

      return c.json({
        data: {
          targetUser,
          truncated,
          workflows,
          tickets,
          dueDates,
          slaRisk,
          ...personal,
        },
      });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
