/**
 * Job options of the "superset-erasure" queue (#728). The queue that adds a job sets them, so these
 * repeat apps/worker/src/superset-erasure-options.ts, which also holds the backoff strategy the
 * worker uses for `type: "custom"`. Both files have a test pinning the same values. 32 attempts with
 * a wait of 1 minute doubling up to 1 hour retry for about 26 hours.
 */
export const SUPERSET_ERASURE_JOB_OPTIONS = {
  attempts: 32,
  backoff: { type: "custom" },
  removeOnComplete: { age: 3_600 },
  removeOnFail: { age: 604_800 },
} as const;
