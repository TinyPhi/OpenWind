import { eq } from "drizzle-orm";
import { db, apiKeys } from "@platform/db";

/**
 * docs/specs/third-party-api-origin-tagging.md, Phase 2 (T5/T6). Resolves the
 * stable per-application anchor (api_keys.oidcClientId) for the key that
 * authenticated the current request, given its row id (applicationActorId —
 * parsed from auth.userId's "apikey:<id>" prefix by
 * applicationActorIdFromUserId, NOT the same value: that id is specific to
 * ONE key row and changes on every rotation, oidcClientId does not — see
 * migration 0090's own comment and rotate.ts, which carries oidcClientId
 * forward unchanged on every rotation).
 *
 * Runs on the bare `db` client (not withTenantContext) — same rationale as
 * create.ts's own Client-ID uniqueness check (migration 0090's comment):
 * api_keys is looked up by its own id here, not filtered by tenant, since
 * the caller already knows which key authenticated this exact request (no
 * cross-tenant enumeration risk — this is a lookup FROM an already-trusted
 * key id, not a search).
 *
 * Returns null if the key row is somehow gone by the time this runs (should
 * be unreachable in practice — the key just authenticated this request) so
 * callers fail closed (reject the write) rather than silently tag with a
 * garbage value.
 */
export async function resolveOriginOidcClientId(
  applicationActorId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ oidcClientId: apiKeys.oidcClientId })
    .from(apiKeys)
    .where(eq(apiKeys.id, applicationActorId))
    .limit(1);
  return row?.oidcClientId ?? null;
}
