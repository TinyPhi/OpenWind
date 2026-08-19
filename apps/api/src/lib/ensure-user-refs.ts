import { eq, and, inArray } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityFields, tenantUsers } from "@platform/db";
import { listOrgUsers } from "./zitadel-management.js";

/**
 * Proactively upserts a tenant_users row for any user_ref-typed custom field
 * value that references a real Zitadel org member who simply hasn't
 * authenticated into this tenant yet.
 *
 * tenant_users is normally only populated by the auth middleware on a
 * successful JWT verification (packages/auth/src/middleware.ts) - so
 * referencing a colleague who hasn't logged into this app yet always failed
 * entity-engine's validateUserRefs() (which only ever checks tenant_users),
 * even though they're a genuine org member. Scoped to orgId via
 * listOrgUsers, so a user outside this tenant's org is left alone and still
 * correctly fails validation afterward - this only ever adds rows for
 * confirmed org members, never bypasses the check itself.
 *
 * Mirrors the already-fixed assignedTo pattern (see create.ts) without
 * adding a Zitadel dependency inside packages/entity-engine - it stays
 * db-only per the platform's dependency rule; this all happens at the
 * apps/api route layer, before createEntity/updateEntity is called.
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

  const candidateIds = [
    ...new Set(
      userRefFieldRows
        .map((f) => fields[f.name])
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ];
  if (candidateIds.length === 0) return;

  const existing = await tx
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(
      and(
        inArray(tenantUsers.userId, candidateIds),
        eq(tenantUsers.tenantId, tenantId),
      ),
    );
  const knownIds = new Set(existing.map((r) => r.userId));
  const missingIds = candidateIds.filter((id) => !knownIds.has(id));
  if (missingIds.length === 0) return;

  const orgUsers = await listOrgUsers(orgId).catch(() => []);
  const orgUserById = new Map(orgUsers.map((u) => [u.userId, u]));

  for (const userId of missingIds) {
    const profile = orgUserById.get(userId);
    if (!profile) continue; // not an org member - entity-engine's own check will reject it
    await tx
      .insert(tenantUsers)
      .values({
        tenantId,
        userId,
        email: profile.email || null,
        displayName: profile.displayName || null,
      })
      .onConflictDoNothing();
  }
}
