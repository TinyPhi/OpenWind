import { sql } from "drizzle-orm";
import type { DbOrTx } from "./middleware.js";

/**
 * Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md R2, T19). Spec-review finding B1:
 * "no business data is returned to platform_admin" must be a structural property of the
 * response shape, not a habit every future route author has to remember. Every
 * `platform_admin`-reachable route (packages/auth's requirePlatformAdmin) returns data
 * through this type, built only by toPlatformAdminSandboxView below -- never a direct
 * passthrough of a Drizzle query result, which could carry any column the author happened
 * to select, including ones added to `tenants` later for unrelated reasons.
 *
 * Deliberately excludes: config, plan, zitadelOrgId, status, suspendedAt,
 * deletionScheduledAt -- none of these are in R2's allowed metadata list, even though they
 * live on the same `tenants` row. Widening this type is itself the explicit, reviewable act
 * that widening platform_admin's visibility requires.
 */
export interface PlatformAdminSandboxView {
  id: string;
  name: string;
  isSandbox: boolean;
  createdAt: string;
  trialStatus: "none" | "active" | "expired";
}

/** The only columns toPlatformAdminSandboxView reads -- matches the GRANT in 0134_platform_admin_sandbox_columns.sql exactly. */
export interface PlatformAdminSandboxRow {
  id: string;
  name: string;
  isSandbox: boolean;
  trialEndsAt: Date | null;
  createdAt: Date;
}

function trialStatus(
  trialEndsAt: Date | null,
): PlatformAdminSandboxView["trialStatus"] {
  if (!trialEndsAt) return "none";
  return trialEndsAt.getTime() > Date.now() ? "active" : "expired";
}

export function toPlatformAdminSandboxView(
  row: PlatformAdminSandboxRow,
): PlatformAdminSandboxView {
  return {
    id: row.id,
    name: row.name,
    isSandbox: row.isSandbox,
    createdAt: row.createdAt.toISOString(),
    trialStatus: trialStatus(row.trialEndsAt),
  };
}

export interface SandboxQuotaCheck {
  allowed: boolean;
  current: number;
  limit: number;
}

/**
 * R11 (spec-review B2): caps how many concurrently-active (non-deleted) sandboxes a single
 * platform_admin can have open. "Deleted" sandboxes are rows removed entirely by T15 (no
 * soft-delete column on `tenants` for this), so every row with `created_by_platform_admin`
 * matching this actor currently counts toward their limit. The caller (T7's creation route)
 * must check this BEFORE provisioning any Zitadel org -- this function only counts existing
 * OpenWind rows, it does not reserve a slot, so the caller is still responsible for not
 * racing two concurrent creation requests from the same platform_admin past the limit.
 */
export async function checkSandboxQuota(
  tx: DbOrTx,
  platformAdminUserId: string,
  limit: number,
): Promise<SandboxQuotaCheck> {
  const rows = await tx.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM tenants
    WHERE is_sandbox AND created_by_platform_admin = ${platformAdminUserId}
  `);
  const current = Number(rows[0]?.count ?? "0");
  return { allowed: current < limit, current, limit };
}
