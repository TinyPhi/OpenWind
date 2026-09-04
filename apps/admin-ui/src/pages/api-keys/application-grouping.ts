import {
  computeApiKeyStatus,
  type ApiKeyRow,
  type ApiKeyStatus,
} from "./status.js";

// Mirrors apps/api/src/routes/api-keys/create.ts's normalizeApplicationName
// exactly (trim + lowercase + collapse whitespace) -- migration 0087
// enforces this same normalization as a real DB uniqueness constraint, so
// grouping client-side by it is safe: two active keys can never legitimately
// have names that normalize to the same value without being the one
// application this groups them as.
export function normalizeApplicationName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface ApplicationGroup {
  /**
   * The raw normalized name, NOT URL-encoded — react-router's useParams
   * decodes path segments automatically, so comparing an encoded value here
   * against a decoded route param would never match. Callers encode with
   * encodeURIComponent only at the point of building a `to`/navigate() URL;
   * this field itself is for equality comparisons.
   */
  slug: string;
  // Display name from the most-recently-created key in the group -- if an
  // application's name casing/whitespace ever varied across its own key
  // history (only possible for rows created before migration 0087 started
  // enforcing normalized uniqueness), the newest key's exact text wins.
  displayName: string;
  keys: ApiKeyRow[];
  status: ApiKeyStatus;
}

const STATUS_RANK: Record<ApiKeyStatus, number> = {
  active: 0,
  rotating: 1,
  expired: 2,
  revoked: 3,
};

/**
 * Groups keys into one entry per unique normalized applicationName. Keys
 * with no applicationName (role-format/internal keys, never produced by
 * this UI's own creation form) are excluded entirely -- this page and its
 * card view are specifically about third-party applications.
 */
export function groupKeysByApplication(
  keys: readonly ApiKeyRow[],
): ApplicationGroup[] {
  const groups = new Map<string, ApiKeyRow[]>();
  for (const key of keys) {
    if (key.applicationName === null) continue;
    const normalized = normalizeApplicationName(key.applicationName);
    const existing = groups.get(normalized);
    if (existing) existing.push(key);
    else groups.set(normalized, [key]);
  }

  return Array.from(groups.entries())
    .map(([normalized, groupKeys]) => {
      const sortedByNewest = [...groupKeys].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      const displayName =
        sortedByNewest[0]?.applicationName ??
        groupKeys[0]?.applicationName ??
        "";
      const status = groupKeys
        .map((k) => computeApiKeyStatus(k, keys))
        .sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])[0] as ApiKeyStatus;
      return {
        slug: normalized,
        displayName,
        keys: sortedByNewest,
        status,
      };
    })
    .sort(
      (a, b) =>
        new Date(b.keys[0]?.createdAt ?? 0).getTime() -
        new Date(a.keys[0]?.createdAt ?? 0).getTime(),
    );
}
