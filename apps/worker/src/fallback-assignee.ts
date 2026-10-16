/**
 * docs/specs/mandatory-ticket-fields.md R7 (owner decision 2026-10-16): who gets a ticket
 * when nobody is named -- an automation without a template assignee, a seeded record with no
 * seeded accounts.
 *
 *   1. the workflow's creator, then its workflow admins, in order -- each only while a
 *      member of this tenant (tenant_users) and not erased;
 *   2. otherwise the tenant's longest-standing admin: the Zitadel admin of this tenant's org
 *      who joined the tenant first.
 *
 * Returns null when there is nobody; callers fail rather than create an unassigned ticket.
 */
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { tenants, tenantUsers, workflows } from "@platform/db";
import { listUserIdsWithRole } from "@platform/auth";
import { logger } from "@platform/logger";

const ERASED = "[REDACTED]";

export async function resolveFallbackAssignee(
  db: DbOrTx,
  tenantId: string,
  workflowId: string | null,
): Promise<string | null> {
  if (workflowId) {
    const [wf] = await db
      .select({ createdBy: workflows.createdBy, admins: workflows.assignedTo })
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflowId),
          or(eq(workflows.tenantId, tenantId), isNull(workflows.tenantId)),
        ),
      )
      .limit(1);
    const candidates = [wf?.createdBy, ...(wf?.admins ?? [])].filter(
      (id): id is string =>
        typeof id === "string" && id !== "" && id !== ERASED,
    );
    if (candidates.length > 0) {
      const members = new Set(
        (
          await db
            .select({ userId: tenantUsers.userId })
            .from(tenantUsers)
            .where(
              and(
                eq(tenantUsers.tenantId, tenantId),
                inArray(tenantUsers.userId, candidates),
              ),
            )
        ).map((r) => r.userId),
      );
      const owner = candidates.find((id) => members.has(id));
      if (owner) return owner;
    }
  }

  const [tenant] = await db
    .select({ orgId: tenants.zitadelOrgId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant?.orgId) return null;

  const admins = await listUserIdsWithRole(tenant.orgId, "admin").catch(
    (err: unknown) => {
      logger.warn(
        { tenantId, err: String(err) },
        "fallback-assignee: could not list the tenant's admins",
      );
      return new Set<string>();
    },
  );
  if (admins.size === 0) return null;

  const [earliest] = await db
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(
      and(
        eq(tenantUsers.tenantId, tenantId),
        inArray(tenantUsers.userId, [...admins]),
      ),
    )
    .orderBy(asc(tenantUsers.createdAt))
    .limit(1);
  return earliest?.userId ?? null;
}
