/**
 * Fill `tenant_users` from Zitadel, which is the source of truth for people.
 *
 * Reporting shows whoever raised or was assigned a ticket, and it can only
 * show a name if one is stored. `tenant_users` is normally written by the auth
 * middleware on sign-in, so a user who has never logged in has no row — and a
 * seeded ticket attributed to them renders as a raw subject id. This syncs the
 * whole org up front so demo data reads like real data.
 *
 * Idempotent: re-running updates names and adds anyone new.
 */
import { db, withTenantContext, tenants, tenantUsers } from "@platform/db";
import { listOrgUsers } from "@platform/auth";
import { eq } from "drizzle-orm";

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "00000000-0000-0000-0000-000000000001";

async function main(): Promise<void> {
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, DEV_TENANT_ID));
  if (!tenant) throw new Error(`No tenant ${DEV_TENANT_ID}`);

  const orgId = tenant.zitadelOrgId;
  if (!orgId) {
    // Deliberately not guessed. The mapping decides whose users land in this
    // tenant, so inventing one would attribute real people to the wrong place.
    throw new Error(
      `Tenant ${DEV_TENANT_ID} has no zitadel_org_id. Set it first — ` +
        `without it there is no way to know which Zitadel org's users belong here.`,
    );
  }

  const orgUsers = await listOrgUsers(orgId);
  if (orgUsers.length === 0) {
    throw new Error(`Zitadel org ${orgId} returned no users`);
  }

  let written = 0;
  for (const user of orgUsers) {
    // Machine/service accounts have no human name; skip rather than store an
    // id as a display name, which is the very thing this fixes.
    const displayName = user.displayName?.trim();
    if (!displayName || displayName === user.userId) continue;

    await withTenantContext(DEV_TENANT_ID, (tx) =>
      tx
        .insert(tenantUsers)
        .values({
          tenantId: DEV_TENANT_ID,
          userId: user.userId,
          email: user.email || null,
          displayName,
        })
        .onConflictDoUpdate({
          target: [tenantUsers.tenantId, tenantUsers.userId],
          set: { email: user.email || null, displayName },
        }),
    );
    written += 1;
    console.log(`  ${user.userId}  ${displayName}  <${user.email}>`);
  }

  console.log(`\nSynced ${written} user(s) into tenant_users.`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
