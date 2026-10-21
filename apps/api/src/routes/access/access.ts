/**
 * GET /auth/access — may this login use this environment? (docs/specs/tenant-access-gate.md R2)
 *
 * The admin UI asks this after the Zitadel login and on every page load, before rendering any
 * page. requireAuth() already refuses an org with no tenant here, a deleted/purged tenant
 * (TENANT_NOT_FOUND), a suspended one (TENANT_SUSPENDED) and an expired sandbox trial
 * (TENANT_TRIAL_EXPIRED); this adds the role check. Roles come from the Zitadel token only —
 * Zitadel is the source of truth for people, never the tenant_users cache.
 */
import { requireAuth } from "@platform/auth";
import { factory } from "./factory.js";

const OPENWIND_ROLES = new Set(["admin", "agent", "user", "superadmin"]);

export const getAccessHandler = factory.createHandlers(requireAuth(), (c) => {
  const { tenantId, roles } = c.get("auth");
  const appRoles = roles.filter((r) => OPENWIND_ROLES.has(r));
  if (appRoles.length === 0) {
    return c.json(
      {
        error: "NO_ROLE",
        message:
          "Your account hasn't been given access to OpenWind. Ask your organisation's admin.",
      },
      403,
    );
  }
  return c.json({ data: { allowed: true, tenantId, roles: appRoles } });
});
