import { isTenantActive } from "@platform/db";
import { logger } from "@platform/logger";

interface GuardOptions {
  jobId?: string | undefined;
  eventType?: string | undefined;
  notificationId?: string | undefined;
  entityTypeId?: string | undefined;
  [key: string]: unknown;
}

/**
 * Validates that a tenant is active.
 * Warns and returns false if the tenant is inactive or missing.
 */
export async function validateActiveTenant(
  tenantId: string,
  workerName: string,
  options: GuardOptions = {},
): Promise<boolean> {
  const active = await isTenantActive(tenantId);
  if (!active) {
    logger.warn(
      { tenantId, workerName, ...options },
      `${workerName}: aborting execution — tenant is deactivated or missing`,
    );
    return false;
  }
  return true;
}
