import { getRedis, withRedisTimeout } from "@platform/redis";
import { withTenantContext } from "@platform/db";
import { fireMisuseAlert } from "@platform/notifications";
import { logger } from "@platform/logger";

/**
 * ADR-012 Phase F, spec R4 — baseline misuse triggers 1 and 2. Trigger 3
 * (tagging-grant-cap breach) is wired separately in
 * apps/worker/src/mention-resolution-worker.ts, onto the same
 * fireMisuseAlert channel, since that's where tag.misuse_rate_capped is
 * already detected.
 *
 * Scope decision: "auth failures" (trigger 1) is scoped to a RECOGNIZED
 * key's scope-check denials (requireTicketScope's 403), not to
 * unrecognized/malformed bearer tokens -- a request that never resolves to
 * a real api_keys row has no key id to attribute a Redis counter to.
 * Nothing in the spec's interview notes named a specific failure class, and
 * "a recognized key repeatedly attempting actions it isn't scoped for" is a
 * real, actionable misuse signal in its own right.
 *
 * Every Redis operation runs inside withRedisTimeout (security-reviewer
 * finding) -- these two functions run on EVERY third-party API request via
 * requireTicketScope, so "fail open on error" isn't enough on its own; a
 * slow-but-not-down Redis must not silently multiply every request's
 * latency. Matches checkRateLimit's own bounded-timeout philosophy.
 */

const AUTH_FAILURE_THRESHOLD = 10;
const AUTH_FAILURE_WINDOW_SECONDS = 300; // 5 minutes, spec R4

const VOLUME_SPIKE_MULTIPLE = 5;
const VOLUME_MIN_BASELINE_HOURS = 24; // spec R4's minimum-sample guard
const VOLUME_BASELINE_WINDOW_HOURS = 168; // trailing 7 days, spec R4
const HOUR_MS = 3_600_000;
// Trigger 2 makes up to 4 sequential Redis round-trips (INCR, EXPIRE, MGET,
// SET NX) per request vs. checkRateLimit's 1 pipelined round-trip -- a
// larger bound than the default 250ms so a healthy-but-not-instant Redis
// isn't mistaken for a timeout on this specific path.
const VOLUME_CHECK_TIMEOUT_MS = 400;

function volumeKey(
  tenantId: string,
  applicationActorId: string,
  hourBucket: number,
): string {
  return `misuse:volume:${tenantId}:${applicationActorId}:${hourBucket}`;
}

/**
 * Trigger 1 -- fires once per breach-episode. Uses a fixed (not sliding)
 * 5-minute window: count resets to 0 when the window's TTL expires, and the
 * alert fires exactly once, on the request where the count first reaches
 * the threshold (Redis INCR strictly increases, so `=== threshold` is true
 * for exactly one request per window). This is a documented simplification
 * of "rolling window" (spec R4) -- a request right at a fixed-window
 * boundary can reset the count slightly earlier than a true sliding window
 * would, which only ever makes the trigger marginally LESS sensitive, never
 * a false positive.
 */
export async function recordScopeDenialAndMaybeAlert(
  tenantId: string,
  applicationActorId: string,
): Promise<void> {
  const shouldAlert = await withRedisTimeout(
    async () => {
      const redis = getRedis();
      const key = `misuse:auth-fail:${tenantId}:${applicationActorId}`;
      // Initialise with TTL and increment atomically in a single round-trip via Lua script
      // to avoid any race condition where a key expires between SET and INCR, leaving it TTL-less.
      const script = `
        redis.call("SET", KEYS[1], "0", "EX", ARGV[1], "NX")
        return redis.call("INCR", KEYS[1])
      `;
      const count = Number(
        await redis.eval(script, 1, key, String(AUTH_FAILURE_WINDOW_SECONDS)),
      );
      return count === AUTH_FAILURE_THRESHOLD;
    },
    false,
    { tenantId, applicationActorId, fn: "recordScopeDenialAndMaybeAlert" },
  );

  if (!shouldAlert) return;

  try {
    await withTenantContext(tenantId, (tx) =>
      fireMisuseAlert(
        tx,
        tenantId,
        `Third-party API key had ${AUTH_FAILURE_THRESHOLD} scope-denied requests within ${AUTH_FAILURE_WINDOW_SECONDS}s`,
        {
          source: "third-party-api-misuse",
          trigger: "auth_failure_rate",
          applicationActorId,
        },
      ),
    );
  } catch (err) {
    logger.warn(
      { err, tenantId, applicationActorId },
      "misuse-alerts: recordScopeDenialAndMaybeAlert failed to write alert",
    );
  }
}

/**
 * Trigger 2 -- fires once per crossing-episode (a Redis NX SET on the
 * per-hour "already alerted" key ensures exactly one alert per hour bucket
 * even though this function runs on every request in that hour). Requires
 * at least 24 hours of prior sample data before it's eligible to fire at
 * all, so a brand-new key's first traffic never triggers a false spike.
 */
export async function recordRequestVolumeAndMaybeAlert(
  tenantId: string,
  applicationActorId: string,
): Promise<void> {
  const decision = await withRedisTimeout(
    async () => {
      const redis = getRedis();
      const hourBucket = Math.floor(Date.now() / HOUR_MS);
      const currentKey = volumeKey(tenantId, applicationActorId, hourBucket);
      const currentCount = await redis.incr(currentKey);
      if (currentCount === 1) {
        // Kept slightly past the full baseline window so the oldest sample
        // is still readable by the last request that needs it as history.
        await redis.expire(
          currentKey,
          (VOLUME_BASELINE_WINDOW_HOURS + 1) * 3600,
        );
      }

      const priorKeys = Array.from(
        { length: VOLUME_BASELINE_WINDOW_HOURS },
        (_, i) => volumeKey(tenantId, applicationActorId, hourBucket - i - 1),
      );
      const priorCounts = await redis.mget(...priorKeys);
      const samples = priorCounts
        .filter((v): v is string => v !== null)
        .map(Number);

      if (samples.length < VOLUME_MIN_BASELINE_HOURS) {
        return { shouldAlert: false as const };
      }

      const baseline = samples.reduce((a, b) => a + b, 0) / samples.length;
      if (baseline <= 0 || currentCount <= baseline * VOLUME_SPIKE_MULTIPLE) {
        return { shouldAlert: false as const };
      }

      const alertedKey = `misuse:volume:alerted:${tenantId}:${applicationActorId}:${hourBucket}`;
      const claimed = await redis.set(alertedKey, "1", "EX", 3600, "NX");
      if (claimed !== "OK") {
        return { shouldAlert: false as const };
      }

      return { shouldAlert: true as const, currentCount, baseline };
    },
    { shouldAlert: false as const },
    { tenantId, applicationActorId, fn: "recordRequestVolumeAndMaybeAlert" },
    VOLUME_CHECK_TIMEOUT_MS,
  );

  if (!decision.shouldAlert) return;

  try {
    await withTenantContext(tenantId, (tx) =>
      fireMisuseAlert(
        tx,
        tenantId,
        `Third-party API key's hourly request volume (${decision.currentCount}) exceeds ${VOLUME_SPIKE_MULTIPLE}x its trailing 7-day hourly baseline (${decision.baseline.toFixed(1)})`,
        {
          source: "third-party-api-misuse",
          trigger: "volume_spike",
          applicationActorId,
          currentCount: decision.currentCount,
          baseline: decision.baseline,
        },
      ),
    );
  } catch (err) {
    logger.warn(
      { err, tenantId, applicationActorId },
      "misuse-alerts: recordRequestVolumeAndMaybeAlert failed to write alert",
    );
  }
}
