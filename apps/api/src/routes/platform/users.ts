import { Hono } from "hono";
import { requireAuth, requireRole } from "@platform/auth";
import {
  db,
  tenantUsers,
  withTenantContext,
  savedViews,
  notificationRecipients,
  ticketAlerts,
  accessRequests,
  apiKeys,
  entityInstances,
  workflows,
  workflowEvents,
} from "@platform/db";
import { eq, and, or, sql } from "drizzle-orm";
import {
  listOrgUsers,
  listUserRolesByUserId,
  invalidateUserCache,
} from "../../lib/zitadel-management.js";
import type { AuthContext } from "@platform/auth";
import { writeAuditEntry } from "@platform/audit";

type AppVars = { Variables: { auth: AuthContext } };

export const usersRouter = new Hono<AppVars>();

// GET /users — returns org users holding the "user" role (customers), alphabetically
// by display name. Feeds both the users page and the @mention picker — neither should
// ever surface agents/admins, so the role filter lives here once for both consumers.
// Merges Zitadel org users (source of truth) with tenant_users DB records
// (which hold locally-resolved display names for users who have logged in).
usersRouter.get(
  "/",
  requireAuth(db),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const { tenantId, orgId } = c.get("auth");

    // ?bust=1 clears the in-memory Zitadel user cache for fresh data
    if (c.req.query("bust") === "1") invalidateUserCache();

    const [zitadelUsers, rolesByUserId, dbRows] = await Promise.all([
      orgId ? listOrgUsers(orgId) : Promise.resolve([]),
      orgId
        ? listUserRolesByUserId(orgId)
        : Promise.resolve(new Map<string, string[]>()),
      withTenantContext(tenantId, (tx) =>
        tx
          .select({
            userId: tenantUsers.userId,
            email: tenantUsers.email,
            displayName: tenantUsers.displayName,
          })
          .from(tenantUsers)
          .where(eq(tenantUsers.tenantId, tenantId)),
      ),
    ]);

    // Build a lookup of DB-enriched display names (set on login)
    const dbByUserId = new Map(dbRows.map((r) => [r.userId, r]));

    // Merge: Zitadel is source of truth for names; DB only enriches when it has
    // a *real* display name (not the userId placeholder stored when JWT has no claims).
    const zitadelByUserId = new Map(zitadelUsers.map((u) => [u.userId, u]));
    // Only surface users holding the "user" role — agents/admins must never appear
    // on the users page or the @mention picker (both consume this endpoint).
    const merged = zitadelUsers
      .filter((u) => (rolesByUserId.get(u.userId) ?? []).includes("user"))
      .map((u) => {
        const dbRow = dbByUserId.get(u.userId);
        // DB display name is only useful when it differs from the userId (i.e. a real name was stored)
        const dbDisplayName =
          dbRow?.displayName && dbRow.displayName !== u.userId
            ? dbRow.displayName
            : null;
        return {
          userId: u.userId,
          email: dbRow?.email ?? u.email,
          displayName: dbDisplayName ?? u.displayName,
          loginName: u.loginName,
          roles: rolesByUserId.get(u.userId) ?? [],
        };
      });

    // Also include DB users not returned by Zitadel (e.g. instance admin in default org).
    // Skip ghost entries: service accounts or stale rows with no email and no real display name.
    for (const r of dbRows) {
      const roles = rolesByUserId.get(r.userId) ?? [];
      if (!zitadelByUserId.has(r.userId) && roles.includes("user")) {
        const realName =
          r.displayName && r.displayName !== r.userId ? r.displayName : null;
        // If there's neither a real name nor an email this is a service account / stale entry — skip it
        if (!realName && !r.email) continue;
        merged.push({
          userId: r.userId,
          email: r.email ?? "",
          displayName: realName ?? r.email ?? r.userId,
          loginName: r.email ?? r.userId,
          roles,
        });
      }
    }

    merged.sort((a, b) => a.displayName.localeCompare(b.displayName));

    return c.json({ data: merged });
  },
);

// DELETE /users/:userId — GDPR per-user erasure endpoint, admin-only
usersRouter.delete(
  "/:userId",
  requireAuth(db),
  requireRole("admin"),
  async (c) => {
    const { tenantId, userId: adminUserId } = c.get("auth");
    const targetUserId = c.req.param("userId");

    await withTenantContext(tenantId, async (tx) => {
      // 1. Delete saved_views
      await tx
        .delete(savedViews)
        .where(
          and(
            eq(savedViews.tenantId, tenantId),
            eq(savedViews.userId, targetUserId),
          ),
        );

      // 2. Delete notification_recipients
      await tx
        .delete(notificationRecipients)
        .where(
          and(
            eq(notificationRecipients.tenantId, tenantId),
            eq(notificationRecipients.userId, targetUserId),
          ),
        );

      // 3. Delete ticket_alerts created by target user
      await tx
        .delete(ticketAlerts)
        .where(
          and(
            eq(ticketAlerts.tenantId, tenantId),
            eq(ticketAlerts.createdBy, targetUserId),
          ),
        );

      // 4. Handle access_requests
      await tx
        .delete(accessRequests)
        .where(
          and(
            eq(accessRequests.tenantId, tenantId),
            eq(accessRequests.requesterId, targetUserId),
          ),
        );

      await tx
        .update(accessRequests)
        .set({ resolvedBy: "[REDACTED]" })
        .where(
          and(
            eq(accessRequests.tenantId, tenantId),
            eq(accessRequests.resolvedBy, targetUserId),
          ),
        );

      // 5. Delete api_keys created or revoked by target user
      await tx
        .delete(apiKeys)
        .where(
          and(
            eq(apiKeys.tenantId, tenantId),
            or(
              eq(apiKeys.createdBy, targetUserId),
              eq(apiKeys.revokedBy, targetUserId),
            ),
          ),
        );

      // 6. Nullify entity_instances references
      await tx
        .update(entityInstances)
        .set({ createdBy: null })
        .where(
          and(
            eq(entityInstances.tenantId, tenantId),
            eq(entityInstances.createdBy, targetUserId),
          ),
        );

      await tx
        .update(entityInstances)
        .set({ assignedTo: null })
        .where(
          and(
            eq(entityInstances.tenantId, tenantId),
            eq(entityInstances.assignedTo, targetUserId),
          ),
        );

      // 7. Handle workflows references
      await tx
        .update(workflows)
        .set({ createdBy: null })
        .where(
          and(
            eq(workflows.tenantId, tenantId),
            eq(workflows.createdBy, targetUserId),
          ),
        );

      await tx
        .update(workflows)
        .set({
          assignedTo: sql`array_remove(${workflows.assignedTo}, ${targetUserId})`,
        })
        .where(
          and(
            eq(workflows.tenantId, tenantId),
            sql`${targetUserId} = ANY(${workflows.assignedTo})`,
          ),
        );

      // 8. Anonymize workflow_events references
      await tx
        .update(workflowEvents)
        .set({ triggeredBy: "[REDACTED]" })
        .where(
          and(
            eq(workflowEvents.tenantId, tenantId),
            eq(workflowEvents.triggeredBy, targetUserId),
          ),
        );

      await tx
        .update(workflowEvents)
        .set({
          actorId: sql`CASE WHEN ${workflowEvents.actorId} = ${targetUserId} THEN '[REDACTED]' ELSE ${workflowEvents.actorId} END`,
        })
        .where(
          and(
            eq(workflowEvents.tenantId, tenantId),
            eq(workflowEvents.actorId, targetUserId),
          ),
        );

      // 9. Delete tenant_users association
      await tx
        .delete(tenantUsers)
        .where(
          and(
            eq(tenantUsers.tenantId, tenantId),
            eq(tenantUsers.userId, targetUserId),
          ),
        );

      // 10. Audit log entry for erasure
      await writeAuditEntry(tx, {
        tenantId,
        actorId: adminUserId,
        actorType: "user",
        resourceType: "user",
        resourceId: targetUserId,
        action: "deleted",
      });
    });

    invalidateUserCache();

    return c.json({ success: true });
  },
);
