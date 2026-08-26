/**
 * @platform/notifications
 *
 * Thin wrapper around Novu SDK providing:
 *  - `sendNotification`  — enqueues a BullMQ delivery job; validates templateId
 *    against a Redis-cached set; never called inside a DB transaction
 *  - `getUserPreferences` / `updateUserPreferences`  — per-user channel prefs
 *    stored in tenants.config JSONB
 *
 * Notification templates are defined in Novu, never in platform TypeScript.
 * The automation engine `notify` action passes the templateId; this package
 * is responsible only for delivery orchestration.
 */

import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { tenants } from "@platform/db";
import { logger } from "@platform/logger";
import { NotificationError } from "./errors.js";
import { DEFAULT_PREFERENCES, mergePreferences } from "./preferences.js";
import type { NotificationPreferences } from "./preferences.js";

export { NotificationError } from "./errors.js";
export type { NotificationPreferences } from "./preferences.js";
export { fireMisuseAlert } from "./misuse-alert.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const QUEUE_NAME = "notifications";
const TEMPLATE_CACHE_KEY = "platform:novu:known_templates";
const TEMPLATE_CACHE_TTL_SECONDS = 300; // 5 min

// ── Notification job payload ──────────────────────────────────────────────────

export type NotificationJobData = {
  tenantId: string;
  userId: string;
  templateId: string;
  payload: Record<string, unknown>;
  digestKey?: string | undefined;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enqueue a notification delivery job.
 *
 * Validates the templateId against a Redis-cached set of known Novu template
 * IDs before enqueuing.  An unknown templateId causes the job to be rejected
 * immediately (throws `NotificationError('TEMPLATE_NOT_FOUND')`) rather than
 * silently dropped downstream.
 *
 * Never call this inside a DB transaction — it enqueues a BullMQ job which
 * runs asynchronously after the transaction commits.
 */
export async function sendNotification(
  redis: Redis,
  tenantId: string,
  userId: string,
  templateId: string,
  payload: Record<string, unknown>,
  options?: { digestKey?: string },
): Promise<void> {
  // Validate templateId against cached known templates
  // On cache miss (first call / TTL expired) we skip validation and let
  // the worker catch unknown templates — this avoids blocking on Novu availability.
  const knownTemplates = await redis
    .smembers(TEMPLATE_CACHE_KEY)
    .catch(() => [] as string[]);

  if (knownTemplates.length > 0 && !knownTemplates.includes(templateId)) {
    throw new NotificationError("TEMPLATE_NOT_FOUND", { templateId });
  }

  const queue = new Queue<NotificationJobData>(QUEUE_NAME, {
    connection: redis,
  });

  try {
    await queue.add(
      "send",
      {
        tenantId,
        userId,
        templateId,
        payload,
        digestKey: options?.digestKey,
      },
      {
        // Remove completed jobs after 1h; keep failed jobs for 7 days
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 604800 },
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
      },
    );
  } catch (err) {
    logger.error(
      { tenantId, userId, templateId, err },
      "notifications: failed to enqueue job",
    );
    throw new NotificationError("PROVIDER_UNAVAILABLE", {
      detail: String(err),
    });
  } finally {
    await queue.close();
  }

  logger.info(
    { tenantId, userId, templateId },
    "notifications: delivery job enqueued",
  );
}

/**
 * Seed the known-templates Redis cache.
 * Called by the worker on startup after fetching workflows from Novu.
 */
export async function seedTemplateCache(
  redis: Redis,
  templateIds: string[],
): Promise<void> {
  if (templateIds.length === 0) return;
  await redis.sadd(TEMPLATE_CACHE_KEY, ...templateIds);
  await redis.expire(TEMPLATE_CACHE_KEY, TEMPLATE_CACHE_TTL_SECONDS);
}

// ── Preferences ───────────────────────────────────────────────────────────────

/**
 * Get a user's notification preferences.
 * Falls back to DEFAULT_PREFERENCES when no preference record exists.
 */
export async function getUserPreferences(
  db: DbOrTx,
  tenantId: string,
  userId: string,
): Promise<NotificationPreferences> {
  const [tenant] = await db
    .select({ config: tenants.config })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!tenant) return { ...DEFAULT_PREFERENCES };

  const config = tenant.config as Record<string, unknown>;
  const notifPrefs = config["notif_prefs"] as
    | Record<string, NotificationPreferences>
    | undefined;
  const userPrefs = notifPrefs?.[userId];

  if (!userPrefs) return { ...DEFAULT_PREFERENCES };

  // Merge with defaults to handle missing keys from older records
  return mergePreferences(DEFAULT_PREFERENCES, userPrefs);
}

/**
 * Persist a user's notification preference changes.
 * Merges the updates onto the existing preferences — partial updates are safe.
 *
 * Uses `jsonb_set` to atomically update only the per-user sub-key inside the
 * `tenants.config` JSONB blob, avoiding the read-modify-write race condition
 * that a full column overwrite would introduce under concurrent preference saves.
 */
export async function updateUserPreferences(
  db: DbOrTx,
  tenantId: string,
  userId: string,
  updates: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const existing = await getUserPreferences(db, tenantId, userId);
  const merged = mergePreferences(existing, updates);

  // jsonb_set(target, path, new_value, create_missing):
  //   - ARRAY['notif_prefs', userId] is the path — both components are bound
  //     parameters so user-supplied userId cannot escape into SQL syntax.
  //   - The merged prefs value is cast to jsonb via Drizzle parameterisation.
  //   - create_missing=true creates the notif_prefs key if absent.
  await db
    .update(tenants)
    .set({
      config: sql`jsonb_set(
        COALESCE(config, '{}'::jsonb),
        ARRAY['notif_prefs', ${userId}],
        ${JSON.stringify(merged)}::jsonb,
        true
      )`,
    })
    .where(eq(tenants.id, tenantId));

  logger.info({ tenantId, userId }, "notifications: preferences updated");
  return merged;
}
