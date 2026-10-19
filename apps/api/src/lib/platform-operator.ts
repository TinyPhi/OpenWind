import { env } from "@platform/config";

/**
 * A caller counts as a platform operator when its tenant is PLATFORM_ORG_ID. With none
 * configured, dev and test allow any superadmin (DEV_TENANT_ID unifies tenant ids there);
 * production refuses every caller rather than letting a `superadmin` granted to a customer user
 * reach cross-tenant routes. Routes answer 404 when this is false, so existence is not revealed.
 */
export function isPlatformOperatorTenant(tenantId: string): boolean {
  if (env.PLATFORM_ORG_ID) return tenantId === env.PLATFORM_ORG_ID;
  return env.NODE_ENV !== "production";
}
