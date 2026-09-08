import { and, eq } from "drizzle-orm";
import { apiKeys, withTenantContext } from "@platform/db";

/**
 * docs/specs/third-party-api-origin-tagging.md, Phase 2 (T5/T6). Resolves the
 * stable per-application anchor (api_keys.oidcClientId) for the key that
 * authenticated the current request, given its row id (applicationActorId —
 * parsed from auth.userId's "apikey:<id>" prefix by
 * applicationActorIdFromUserId, NOT the same value: that id is specific to
 * ONE key row and changes on every rotation, oidcClientId does not — see
 * migration 0091's own comment and rotate.ts, which carries oidcClientId
 * forward unchanged on every rotation).
 *
 * Goes through withTenantContext (not the bare `db` client) because api_keys
 * has RLS (tenant_read/tenant_write policies gated on app.tenant_id) and the
 * app connects as the non-superuser `app_user` role in every real deployment
 * — without setting app.tenant_id first, the policy's comparison against
 * NULL means this SELECT always returns zero rows. requireAuth() always runs
 * its own withTenantContext block first (to upsert tenant_users), which
 * "poisons" the connection's app.tenant_id GUC into the reset ('') state for
 * any later bare query reusing the same pooled connection (migration 0091's
 * own documented rationale for the same bug class elsewhere) — this made
 * every third-party ticket/comment/sub-ticket create 401 with "Invalid API
 * key" even for a valid key, since a null here is treated as fail-closed
 * below.
 *
 * PR #574 review (VijitP) — carries the explicit eq(apiKeys.tenantId, ...)
 * filter alongside withTenantContext, matching db-conventions.md's
 * defence-in-depth requirement (RLS and an explicit filter are both
 * required, never alternatives). The caller already knows which tenant
 * authenticated this exact request, so this isn't a new cross-tenant
 * enumeration risk — but once tenantId is accepted as a parameter at all,
 * skipping the app-layer filter would mean a misconfigured/suspended/
 * regressed RLS policy silently resolves a different tenant's key.
 *
 * Returns null if the key row is somehow gone by the time this runs (should
 * be unreachable in practice — the key just authenticated this request) so
 * callers fail closed (reject the write) rather than silently tag with a
 * garbage value.
 */
export async function resolveOriginOidcClientId(
  tenantId: string,
  applicationActorId: string,
): Promise<string | null> {
  const [row] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({ oidcClientId: apiKeys.oidcClientId })
      .from(apiKeys)
      .where(
        and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, applicationActorId)),
      )
      .limit(1),
  );
  return row?.oidcClientId ?? null;
}
