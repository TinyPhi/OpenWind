import { eq, and, isNull, or, inArray, sql, desc, type SQL } from "drizzle-orm";
import { withTenantContext, entityInstances } from "@platform/db";

/**
 * Single source of truth for "is this user scoped to this ticket" — creator,
 * assignee, or a manual/mention grant in fields.__accessUsers. my-tickets.ts
 * and the personal-dashboard endpoint both delegate here so the two surfaces
 * can never drift into different predicates (see docs/specs/personal-dashboard.md §V).
 *
 * Takes an array (not a single userId) so a future org-hierarchy rollup can
 * pass [me, ...subordinateIds] without changing this function's contract.
 */
export function buildUserScopeFilter(userIds: string[]): SQL | undefined {
  return or(
    inArray(entityInstances.createdBy, userIds),
    inArray(entityInstances.assignedTo, userIds),
    sql`${entityInstances.fields}->'__accessUsers' ?| ARRAY[${sql.join(
      userIds.map((u) => sql`${u}`),
      sql`, `,
    )}]`,
  );
}

export interface ResolveScopedIdsOptions {
  workflowId?: string;
  limit?: number;
}

/**
 * Resolves the entity_instance ids a set of users is scoped to, tenant-scoped,
 * newest first. Returns ids only — callers fetch whatever columns they need
 * for the ids they care about, keeping this helper cheap to reuse across
 * my-tickets, the dashboard, and (later) an org-view rollup.
 */
export async function resolveUserScopedEntityIds(
  tenantId: string,
  userIds: string[],
  opts: ResolveScopedIdsOptions = {},
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const { workflowId, limit } = opts;

  const conditions = and(
    eq(entityInstances.tenantId, tenantId),
    isNull(entityInstances.deletedAt),
    buildUserScopeFilter(userIds),
    workflowId ? eq(entityInstances.workflowId, workflowId) : undefined,
  );

  const rows = await withTenantContext(tenantId, (tx) => {
    const query = tx
      .select({ id: entityInstances.id })
      .from(entityInstances)
      .where(conditions)
      .orderBy(desc(entityInstances.createdAt));
    return limit ? query.limit(limit) : query;
  });

  return rows.map((r) => r.id);
}
