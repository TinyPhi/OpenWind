/**
 * What happened to a BullMQ job after `job.waitUntilFinished` rejected.
 *
 * `waitUntilFinished` rejects in two unrelated ways: the wait's own timeout ("Job wait <name> timed
 * out before finishing, ..."), and the job failing, in which case the error carries the worker's
 * `failedReason`, which can itself say "timed out" (a Zitadel fetch, say). The message cannot tell
 * them apart, the job's state can: `failed` is a real failure, a job that is still queued or
 * running means only the wait gave up.
 */
export type JobWaitOutcome =
  | "still-running"
  | "failed"
  | "completed"
  | "unknown";

const STILL_RUNNING_STATES = new Set([
  "active",
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
]);

export async function classifyJobAfterWaitError(job: {
  getState(): Promise<string>;
}): Promise<JobWaitOutcome> {
  let state: string;
  try {
    state = await job.getState();
  } catch {
    return "unknown";
  }
  if (state === "failed") return "failed";
  if (state === "completed") return "completed";
  return STILL_RUNNING_STATES.has(state) ? "still-running" : "unknown";
}
