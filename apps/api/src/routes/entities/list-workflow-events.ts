import { inArray } from "drizzle-orm";
import { requireAuth } from "@platform/auth";
import { tenantUsers, withTenantContext } from "@platform/db";
import { getWorkflowEventLog } from "@platform/workflow-engine";
import { listOrgUsers } from "../../lib/zitadel-management.js";
import { logger } from "@platform/logger";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

function resolveDisplayName(
  userId: string,
  nameMap: Map<string, string>,
): string {
  return nameMap.get(userId) ?? userId.slice(0, 8) + "…";
}

export const listWorkflowEventsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, orgId } = c.get("auth");

    try {
      const events = await withTenantContext(tenantId, (tx) =>
        getWorkflowEventLog(tx, tenantId, id),
      );

      // Collect all user IDs referenced in events (actors + assignedTo changes)
      const userIds = new Set<string>();
      for (const e of events) {
        if (e.actorId) userIds.add(e.actorId);
        const meta = e.metadata as {
          changed?: Record<string, { old: unknown; new: unknown }>;
          mentions?: string[];
        };
        const changed = meta.changed;
        const at = changed?.["assignedTo"];
        if (at?.old && typeof at.old === "string") userIds.add(at.old);
        if (at?.new && typeof at.new === "string") userIds.add(at.new);
        if (meta.mentions) for (const m of meta.mentions) userIds.add(m);
      }

      // Build name map: Zitadel is source of truth, tenant_users fills gaps
      // (Same merge logic as GET /users — cached in Zitadel management layer)
      const nameMap = new Map<string, string>();
      if (userIds.size > 0) {
        const [zitadelUsers, dbRows] = await Promise.all([
          orgId ? listOrgUsers(orgId) : Promise.resolve([]),
          withTenantContext(tenantId, (tx) =>
            tx
              .select({
                userId: tenantUsers.userId,
                displayName: tenantUsers.displayName,
                email: tenantUsers.email,
              })
              .from(tenantUsers)
              .where(inArray(tenantUsers.userId, [...userIds])),
          ),
        ]);

        const dbByUserId = new Map(dbRows.map((r) => [r.userId, r]));

        for (const u of zitadelUsers) {
          if (!userIds.has(u.userId)) continue;
          const dbRow = dbByUserId.get(u.userId);
          const dbDisplayName =
            dbRow?.displayName && dbRow.displayName !== u.userId
              ? dbRow.displayName
              : null;
          const name = dbDisplayName ?? u.displayName;
          if (name) nameMap.set(u.userId, name);
        }

        // Fill any IDs not in Zitadel from DB (e.g. instance admin)
        for (const r of dbRows) {
          if (nameMap.has(r.userId)) continue;
          const realName =
            r.displayName && r.displayName !== r.userId ? r.displayName : null;
          const name = realName ?? r.email;
          if (name) nameMap.set(r.userId, name);
        }
      }

      logger.info(
        { userCount: userIds.size, resolvedCount: nameMap.size },
        "history-enrich: nameMap built",
      );

      // Enrich events with resolved display names
      const enriched = events.map((e) => {
        // Prefer snapshot stored in metadata (immutable truth for new events),
        // but discard if it's just the raw userId (old bad data or no name available).
        const rawSnapshot = (e.metadata as { actorName?: string | null })
          .actorName;
        const snapshotName =
          rawSnapshot && rawSnapshot !== e.actorId ? rawSnapshot : null;
        const actorDisplayName =
          snapshotName ??
          (e.actorId ? resolveDisplayName(e.actorId, nameMap) : null);

        const changed = (
          e.metadata as {
            changed?: Record<string, { old: unknown; new: unknown }>;
          }
        ).changed;
        let enrichedChanged: Record<string, unknown> | undefined = changed;
        if (changed?.["assignedTo"]) {
          const at = changed["assignedTo"];
          enrichedChanged = {
            ...changed,
            assignedTo: {
              ...(at as Record<string, unknown>),
              oldName:
                at.old && typeof at.old === "string"
                  ? resolveDisplayName(at.old, nameMap)
                  : null,
              newName:
                at.new && typeof at.new === "string"
                  ? resolveDisplayName(at.new, nameMap)
                  : null,
            },
          };
        }

        return {
          ...e,
          actorDisplayName,
          metadata: { ...e.metadata, changed: enrichedChanged },
        };
      });

      return c.json({ data: enriched });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
