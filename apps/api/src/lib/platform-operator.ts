import { env } from "@platform/config";
import { logger } from "@platform/logger";

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

export function logFenceDenied(tenantId: string, path: string): void {
  logger.warn({ tenantId, path }, "platform operator fence: access denied");
}

/** True, after logging the denial, when the caller must get a 404 from a platform-operator route. */
export function denyUnlessPlatformOperator(
  tenantId: string,
  path: string,
): boolean {
  if (isPlatformOperatorTenant(tenantId)) return false;
  logFenceDenied(tenantId, path);
  return true;
}
