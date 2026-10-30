/**
 * Shared helpers for worker sweeps that must visit every tenant (issue #1078).
 *
 * The worker connects as app_user, which is subject to RLS, so a query with no tenant
 * context either sees zero rows or errors on `''::uuid`. Sweeps therefore enumerate tenants
 * (the `tenants` table has no RLS) and run each tenant's work inside withTenantContext.
 * No BYPASSRLS role is involved.
 */

import { ne } from "drizzle-orm";
import { db, tenants } from "@platform/db";
import { logger } from "@platform/logger";

export interface SweepTenant {
  id: string;
  trialEndsAt: Date | null;
}

export class TenantSweepError extends Error {
  readonly code = "TENANT_SWEEP_FAILED";
  constructor(
    readonly sweep: string,
    readonly tenantId: string,
    options?: { cause?: unknown },
  ) {
    super(`${sweep}: sweep failed for tenant ${tenantId}`, options);
    this.name = "TenantSweepError";
  }
}

/** Every tenant that has not been deleted (deleted tenants are handled by tenant-purge). */
export async function listSweepTenants(): Promise<SweepTenant[]> {
  return db
    .select({ id: tenants.id, trialEndsAt: tenants.trialEndsAt })
    .from(tenants)
    .where(ne(tenants.status, "deleted"));
}

export interface TenantSweepResult<T> {
  results: Map<string, T>;
  failedTenantIds: string[];
}

/**
 * Runs `fn` once per tenant, sequentially. A failure for one tenant is logged (with the
 * tenantId) and recorded in `failedTenantIds`; it never stops the remaining tenants.
 */
export async function forEachTenant<T>(
  sweep: string,
  tenantIds: readonly string[],
  fn: (tenantId: string) => Promise<T>,
): Promise<TenantSweepResult<T>> {
  const results = new Map<string, T>();
  const failedTenantIds: string[] = [];
  for (const tenantId of tenantIds) {
    try {
      results.set(tenantId, await fn(tenantId));
    } catch (err) {
      const sweepErr = new TenantSweepError(sweep, tenantId, { cause: err });
      failedTenantIds.push(tenantId);
      logger.error(
        { tenantId, code: sweepErr.code, err: String(err) },
        `${sweep}: tenant sweep failed — continuing with remaining tenants`,
      );
    }
  }
  return { results, failedTenantIds };
}
