import { eq, and, inArray } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityFields, tenantUsers, withTenantContext } from "@platform/db";
import { listOrgUsers } from "./zitadel-management.js";
import type { OrgUser } from "./zitadel-management.js";

/**
 * Returns which of `userIds` are members of this tenant, upserting a tenant_users row for any
 * that are genuine members of the tenant's Zitadel org but haven't signed in to this app yet.
 *
 * tenant_users is normally only populated by the auth middleware on a successful JWT
 * verification (packages/auth/src/middleware.ts), so a colleague who exists in Zitadel but has
 * never signed in failed every tenant_users-only membership check -- e.g. an @mention of them
 * silently notified nobody. Scoped to orgId via listOrgUsers: an id outside this tenant's org is
 * never added and is left out of the result, so callers keep rejecting it. Without an orgId only
 * existing tenant_users rows count (fail closed, no Zitadel call).
 */
export async function ensureTenantMembers(
  tx: DbOrTx,
  tenantId: string,
  userIds: string[],
  orgId: string | undefined,
): Promise<Set<string>> {
  const candidateIds = [...new Set(userIds.filter((id) => id.length > 0))];
  if (candidateIds.length === 0) return new Set();

  const members = await findTenantMembers(tx, tenantId, candidateIds);
  const missingIds = candidateIds.filter((id) => !members.has(id));
  if (missingIds.length === 0 || !orgId) return members;

  const orgUsers = await listOrgUsers(orgId).catch(() => []);
  await registerOrgMembers(tx, tenantId, missingIds, orgUsers, members);
  return members;
}

/**
 * Same result as ensureTenantMembers, for callers with no transaction of their own: membership
 * is read in one short tenant context, Zitadel is called with none open (so a slow or
 * rate-limited lookup never holds a database connection), and a second short context records
 * the new members.
 */
export async function resolveTenantMembers(
  tenantId: string,
  userIds: string[],
  orgId: string | undefined,
): Promise<Set<string>> {
  const candidateIds = [...new Set(userIds.filter((id) => id.length > 0))];
  if (candidateIds.length === 0) return new Set();

  const members = await withTenantContext(tenantId, (tx) =>
    findTenantMembers(tx, tenantId, candidateIds),
  );
  const missingIds = candidateIds.filter((id) => !members.has(id));
  if (missingIds.length === 0 || !orgId) return members;

  const orgUsers = await listOrgUsers(orgId).catch(() => []);
  if (!missingIds.some((id) => orgUsers.some((u) => u.userId === id))) {
    return members;
  }
  await withTenantContext(tenantId, (tx) =>
    registerOrgMembers(tx, tenantId, missingIds, orgUsers, members),
  );
  return members;
}

async function findTenantMembers(
  tx: DbOrTx,
  tenantId: string,
  candidateIds: string[],
): Promise<Set<string>> {
  const existing = await tx
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(
      and(
        inArray(tenantUsers.userId, candidateIds),
        eq(tenantUsers.tenantId, tenantId),
      ),
    );
  return new Set(existing.map((r) => r.userId));
}

// Upserts a tenant_users row for each missing id that is a real member of the org, and adds it to
// `members`. An id outside the org is skipped, so the caller's own check still rejects it.
async function registerOrgMembers(
  tx: DbOrTx,
  tenantId: string,
  missingIds: string[],
  orgUsers: OrgUser[],
  members: Set<string>,
): Promise<void> {
  const orgUserById = new Map(orgUsers.map((u) => [u.userId, u]));
  for (const userId of missingIds) {
    const profile = orgUserById.get(userId);
    if (!profile) continue;
    await tx
      .insert(tenantUsers)
      .values({
        tenantId,
        userId,
        email: profile.email || null,
        displayName: profile.displayName || null,
      })
      .onConflictDoNothing();
    members.add(userId);
  }
}

/**
 * Proactively makes sure every user_ref-typed custom field value that references a real Zitadel
 * org member is in tenant_users, so entity-engine's validateUserRefs() (which only checks
 * tenant_users) accepts colleagues who haven't signed in yet. A value outside the org is left
 * alone and still fails that validation afterward.
 *
 * Mirrors the already-fixed assignedTo pattern (see create.ts) without adding a Zitadel
 * dependency inside packages/entity-engine - it stays db-only per the platform's dependency
 * rule; this all happens at the apps/api route layer, before createEntity/updateEntity.
 *
 * Takes no transaction: callers run it BEFORE opening the entity transaction, so the Zitadel
 * lookup never holds a database connection. The tenant_users upsert commits in its own short
 * context; a later createEntity/updateEntity failure leaves only rows for genuine org members.
 */
export async function ensureUserRefsKnown(
  tenantId: string,
  entityTypeId: string,
  fields: Record<string, unknown>,
  orgId: string | undefined,
): Promise<void> {
  if (!orgId) return;

  const userRefFieldRows = await withTenantContext(tenantId, (tx) =>
    tx
      .select({ name: entityFields.name })
      .from(entityFields)
      .where(
        and(
          eq(entityFields.entityTypeId, entityTypeId),
          eq(entityFields.fieldType, "user_ref"),
        ),
      ),
  );
  if (userRefFieldRows.length === 0) return;

  const candidateIds = userRefFieldRows
    .map((f) => fields[f.name])
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  await resolveTenantMembers(tenantId, candidateIds, orgId);
}
