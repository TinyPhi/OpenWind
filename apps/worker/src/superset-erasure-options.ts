/**
 * The retry rules of the "superset-erasure" queue (#728). Kept in a module with no side effects so a
 * test can pin them. apps/api/src/lib/superset-erasure-options.ts repeats the job options, because
 * the queue that adds a job sets them and the dependency rule keeps apps/api and apps/worker from
 * importing each other; both files have a test pinning the same values.
 */

export const SUPERSET_ERASURE_ATTEMPTS = 32;

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 3_600_000;

/**
 * Wait before the next attempt: 1, 2, 4, 8, 16, 32 minutes, then 1 hour. With 32 attempts the
 * retries span about 26 hours, which is the spec's "at least 24 h". BullMQ's built-in exponential
 * backoff has no cap, so this is a custom strategy, set on the Worker.
 */
export function supersetErasureBackoff(attemptsMade: number): number {
  return Math.min(
    BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsMade - 1),
    BACKOFF_CAP_MS,
  );
}

export const SUPERSET_ERASURE_JOB_OPTIONS = {
  attempts: SUPERSET_ERASURE_ATTEMPTS,
  backoff: { type: "custom" },
  removeOnComplete: { age: 3_600 },
  removeOnFail: { age: 604_800 },
} as const;
