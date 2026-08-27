/**
 * Per-tenant admin-editable rate-limit ceiling (ADR-012 Phase G, ADR-013).
 *
 * Stored in `tenants.config` JSONB under the `rate_limit_per_min` key —
 * same storage convention as notifications' per-user preferences
 * (packages/notifications/src/preferences.ts) rather than a dedicated
 * column, since this is a single optional override value, not a
 * relational shape.
 *
 * A 5s in-process TTL cache avoids a DB round-trip on every authenticated
 * request. Spec R2 only requires the override to "take effect within 5s" —
 * a flat TTL alone satisfies that bound without needing the cross-instance
 * pub/sub invalidation tenant-status-cache.ts uses (that's for a much
 * longer 30s TTL where the extra propagation path pays for itself; here
 * the window is already short enough that plain expiry is sufficient).
 */

import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { tenants } from "@platform/db";

const TTL_MS = 5_000;

const _cache = new Map<string, { value: number | null; exp: number }>();

export async function getTenantRateLimitOverride(
  db: DbOrTx,
  tenantId: string,
): Promise<number | null> {
  const cached = _cache.get(tenantId);
  if (cached && Date.now() <= cached.exp) {
    return cached.value;
  }

  const [row] = await db
    .select({ config: tenants.config })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const config = (row?.config as Record<string, unknown> | undefined) ?? {};
  const raw = config["rate_limit_per_min"];
  const value = typeof raw === "number" && raw > 0 ? raw : null;

  _cache.set(tenantId, { value, exp: Date.now() + TTL_MS });
  return value;
}

/**
 * Sets or clears (ratePerMin: null) the tenant's rate-limit override.
 *
 * jsonb_set with create_missing=true when setting; a direct key-removal
 * expression when clearing -- both bind tenantId as a parameter, never
 * string-concatenated into the query.
 */
export async function setTenantRateLimitOverride(
  db: DbOrTx,
  tenantId: string,
  ratePerMin: number | null,
): Promise<void> {
  if (ratePerMin === null) {
    await db
      .update(tenants)
      .set({
        config: sql`COALESCE(config, '{}'::jsonb) - 'rate_limit_per_min'`,
      })
      .where(eq(tenants.id, tenantId));
  } else {
    await db
      .update(tenants)
      .set({
        config: sql`jsonb_set(
          COALESCE(config, '{}'::jsonb),
          ARRAY['rate_limit_per_min'],
          ${JSON.stringify(ratePerMin)}::jsonb,
          true
        )`,
      })
      .where(eq(tenants.id, tenantId));
  }

  _cache.delete(tenantId);
}

/** Test-only escape hatch to avoid cross-test cache bleed. */
export function _clearTenantRateLimitCacheForTests(): void {
  _cache.clear();
}
