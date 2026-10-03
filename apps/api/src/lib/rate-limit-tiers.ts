import { getRedis, checkRateLimit } from "@platform/redis";
import { env } from "@platform/config";
import { logger } from "@platform/logger";

const KEY_PERSON_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * ADR-012 Phase G, ADR-013 — third rate-limit tier, scoped to a single
 * acting person's own share of one API key's traffic. Distinct from
 * @platform/auth's tenant tier (enforceTenantRateLimit) and per-key
 * aggregate tier (enforceApiKeyRateLimit) — both of those run inside
 * requireAuth, before requireActingPerson has resolved a person identity,
 * so this tier can only be checked here, in requireTicketScope, which runs
 * after both.
 *
 * Fails open (never throws) on any Redis error, matching checkRateLimit's
 * own bounded-timeout contract and every other rate-limit tier in this
 * codebase.
 */
export async function enforceKeyPersonRateLimit(
  tenantId: string,
  applicationActorId: string,
  actingPersonId: string,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  try {
    return await checkRateLimit(
      getRedis(),
      `rl:key-person:${tenantId}:${applicationActorId}:${actingPersonId}`,
      env.RATE_LIMIT_API_KEY_PERSON_PER_MIN,
      KEY_PERSON_RATE_LIMIT_WINDOW_SECONDS,
    );
  } catch (err) {
    logger.warn(
      { err, tenantId, applicationActorId, actingPersonId },
      "rate-limit-tiers: key-person check failed unexpectedly — failing open",
    );
    return {
      allowed: true,
      remaining: env.RATE_LIMIT_API_KEY_PERSON_PER_MIN,
      resetAt: 0,
    };
  }
}

const EXPORT_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * ADR-013, #692 — per-(tenant, user) cap on GET /entity-types/:id/export.
 * Keyed on the verified auth identity, so it must run after requireAuth.
 * Fails open like every other tier.
 */
export async function enforceExportRateLimit(
  tenantId: string,
  userId: string,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  try {
    return await checkRateLimit(
      getRedis(),
      `rl:export:${tenantId}:${userId}`,
      env.RATE_LIMIT_EXPORT_PER_MIN,
      EXPORT_RATE_LIMIT_WINDOW_SECONDS,
    );
  } catch (err) {
    logger.warn(
      { err, tenantId, userId },
      "rate-limit-tiers: export check failed unexpectedly — failing open",
    );
    return {
      allowed: true,
      remaining: env.RATE_LIMIT_EXPORT_PER_MIN,
      resetAt: 0,
    };
  }
}
