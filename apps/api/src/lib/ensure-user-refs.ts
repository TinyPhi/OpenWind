import { eq, and, inArray } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityFields, tenantUsers } from "@platform/db";
import { listOrgUsers } from "./zitadel-management.js";

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

  const existing = await tx
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(
      and(
        inArray(tenantUsers.userId, candidateIds),
        eq(tenantUsers.tenantId, tenantId),
      ),
    );
  const members = new Set(existing.map((r) => r.userId));
  const missingIds = candidateIds.filter((id) => !members.has(id));
  if (missingIds.length === 0 || !orgId) return members;

  const orgUsers = await listOrgUsers(orgId).catch(() => []);
  const orgUserById = new Map(orgUsers.map((u) => [u.userId, u]));

  for (const userId of missingIds) {
    const profile = orgUserById.get(userId);
    if (!profile) continue; // not an org member -- the caller's own check rejects it
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
  return members;
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
 */
export async function ensureUserRefsKnown(
  tx: DbOrTx,
  tenantId: string,
  entityTypeId: string,
  fields: Record<string, unknown>,
  orgId: string | undefined,
): Promise<void> {
  if (!orgId) return;

  const userRefFieldRows = await tx
    .select({ name: entityFields.name })
    .from(entityFields)
    .where(
      and(
        eq(entityFields.entityTypeId, entityTypeId),
        eq(entityFields.fieldType, "user_ref"),
      ),
    );
  if (userRefFieldRows.length === 0) return;

  const candidateIds = userRefFieldRows
    .map((f) => fields[f.name])
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  await ensureTenantMembers(tx, tenantId, candidateIds, orgId);
}
