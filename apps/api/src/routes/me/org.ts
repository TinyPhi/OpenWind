/**
 * GET /me/org -- the caller's own org brand for the app header (R12,
 * docs/specs/multi-org-sandbox.md).
 *
 * Returns { name, logo } for a sandbox tenant and null for every other tenant, whose header keeps
 * the OpenWind brand. The response never carries isSandbox: the prospect-facing UI must not be
 * able to tell it is a sandbox (§C "UI scope").
 */
import { requireAuth } from "@platform/auth";
import { tenants, withTenantContext } from "@platform/db";
import { eq } from "drizzle-orm";
import { factory } from "./factory.js";

export const getOrgBrandingHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const { tenantId } = c.get("auth");
    // `tenants` has no RLS policy in any migration, so this explicit id filter is the only guard.
    const [row] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          name: tenants.name,
          logo: tenants.logo,
          isSandbox: tenants.isSandbox,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    );
    if (!row?.isSandbox) return c.json({ data: null });
    return c.json({ data: { name: row.name, logo: row.logo } });
  },
);
