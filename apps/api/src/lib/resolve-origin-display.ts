import { inArray, eq, desc, sql } from "drizzle-orm";
import { db, apiKeys } from "@platform/db";
import { getUserById } from "./zitadel-management.js";

export type OriginDisplay = {
  mechanism: "api" | "handoff";
  appName: string;
  performerUserId: string;
  performerDisplayName: string;
} | null;

type OriginColumns = {
  originMechanism: string | null;
  originOidcClientId: string | null;
  originPerformerUserId: string | null;
};

/**
 * docs/specs/third-party-api-origin-tagging.md §C — resolves the live
 * (never frozen) application name for an origin-tagged row's
 * origin_oidc_client_id, by joining to whichever api_keys row is CURRENTLY
 * active for that client id. A rename after the ticket was created shows
 * the new name; a rotation (which carries oidcClientId forward unchanged,
 * see rotate.ts) keeps resolving to the same application throughout.
 *
 * Falls back to a placeholder name if every key sharing that client id has
 * since been revoked/deleted (an edge case, not the common path) rather
 * than throwing — a read endpoint must never 500 because of stale
 * provenance data on an old row.
 */
export async function resolveOriginDisplay(
  row: OriginColumns,
): Promise<OriginDisplay> {
  if (!row.originMechanism || !row.originOidcClientId) return null;

  const [appName, performerDisplayName] = await Promise.all([
    lookupApplicationName(row.originOidcClientId),
    lookupPerformerDisplayName(row.originPerformerUserId),
  ]);
  return {
    mechanism: row.originMechanism as "api" | "handoff",
    appName,
    performerUserId: row.originPerformerUserId ?? "",
    performerDisplayName,
  };
}

// Same last-resort single-user lookup list-workflow-events.ts falls back to
// for actorId names not found in a batch — getUserById is itself 5-minute
// cached (packages/auth/src/zitadel-management.ts), so per-row calls here
// are cheap on repeat views. Falls back to the raw id (never throws) so a
// deactivated/deleted Zitadel user never 500s a read endpoint.
async function lookupPerformerDisplayName(
  performerUserId: string | null,
): Promise<string> {
  if (!performerUserId) return "";
  const user = await getUserById(performerUserId);
  if (!user) return performerUserId;
  const name = user.displayName !== user.userId ? user.displayName : null;
  return (name ?? user.loginName) || performerUserId;
}

async function lookupApplicationName(oidcClientId: string): Promise<string> {
  // Prefer the currently-active (non-revoked) row sharing this client id --
  // a rotation lineage can have several historical rows, and only the
  // active one reflects the application's current name (a rename updates
  // the active row, not its now-revoked predecessors). Falls back to the
  // most recently created row if every one has since been revoked (edge
  // case: the whole lineage was decommissioned but old tickets still
  // reference it).
  const [key] = await db
    .select({ applicationName: apiKeys.applicationName })
    .from(apiKeys)
    .where(eq(apiKeys.oidcClientId, oidcClientId))
    .orderBy(sql`${apiKeys.revokedAt} IS NULL DESC`, desc(apiKeys.createdAt))
    .limit(1);
  return key?.applicationName ?? "Unknown application";
}

/**
 * Batch variant for list endpoints — one query instead of N. Returns
 * oidcClientId -> live application name; callers combine each row's own
 * originMechanism/originPerformerUserId (already on the row) with a lookup
 * into this map, so no fragile composite key is needed.
 */
export async function batchLookupApplicationNames(
  rows: OriginColumns[],
): Promise<Map<string, string>> {
  const clientIds = [
    ...new Set(
      rows
        .filter((r) => r.originMechanism && r.originOidcClientId)
        .map((r) => r.originOidcClientId as string),
    ),
  ];
  if (clientIds.length === 0) return new Map();

  // Same active-row-first, most-recent-fallback ordering as
  // lookupApplicationName above — first-wins below only picks the "best"
  // row per client id because this order guarantees it arrives first.
  const keys = await db
    .select({
      oidcClientId: apiKeys.oidcClientId,
      applicationName: apiKeys.applicationName,
    })
    .from(apiKeys)
    .where(inArray(apiKeys.oidcClientId, clientIds))
    .orderBy(sql`${apiKeys.revokedAt} IS NULL DESC`, desc(apiKeys.createdAt));

  const nameByClientId = new Map<string, string>();
  for (const k of keys) {
    if (!k.oidcClientId) continue;
    if (!nameByClientId.has(k.oidcClientId) && k.applicationName) {
      nameByClientId.set(k.oidcClientId, k.applicationName);
    }
  }
  return nameByClientId;
}

/**
 * Batch variant of lookupPerformerDisplayName for list endpoints — one
 * round of (cached) getUserById calls instead of one per row rendered.
 */
export async function batchLookupPerformerNames(
  rows: OriginColumns[],
): Promise<Map<string, string>> {
  const performerIds = [
    ...new Set(
      rows
        .filter((r) => r.originMechanism && r.originPerformerUserId)
        .map((r) => r.originPerformerUserId as string),
    ),
  ];
  if (performerIds.length === 0) return new Map();

  const nameByUserId = new Map<string, string>();
  await Promise.all(
    performerIds.map(async (uid) => {
      const name = await lookupPerformerDisplayName(uid);
      if (name) nameByUserId.set(uid, name);
    }),
  );
  return nameByUserId;
}

export function toOriginDisplay(
  row: OriginColumns,
  nameByClientId: Map<string, string>,
  performerNameByUserId: Map<string, string> = new Map(),
): OriginDisplay {
  if (!row.originMechanism || !row.originOidcClientId) return null;
  const performerUserId = row.originPerformerUserId ?? "";
  return {
    mechanism: row.originMechanism as "api" | "handoff",
    appName:
      nameByClientId.get(row.originOidcClientId) ?? "Unknown application",
    performerUserId,
    performerDisplayName:
      performerNameByUserId.get(performerUserId) ?? performerUserId,
  };
}
