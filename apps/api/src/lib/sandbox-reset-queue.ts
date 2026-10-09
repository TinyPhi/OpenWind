/**
 * One Queue instance per process for enqueuing — the worker holds the Worker
 * (apps/worker/src/sandbox-reset-worker.ts), matching the same split as
 * apps/api/src/lib/sandbox-provisioning-queue.ts. A QueueEvents instance is also kept here
 * (not available via @platform/telemetry's Queue/Worker wrapper) so the reset route can
 * `await job.waitUntilFinished(sandboxResetQueueEvents)` and respond to the platform admin
 * only once the worker has actually finished wiping+reseeding -- T13 deliberately has no
 * separate progress-polling endpoint (unlike T7/T8's provisioning flow), so this is the only
 * way the route's single response can reflect the job's real outcome.
 */
import { Queue, QueueEvents } from "bullmq";
import { connection } from "./redis.js";

export interface SandboxResetJobPayload {
  tenantId: string;
  requestedBy: string;
}

export const sandboxResetQueue = new Queue<SandboxResetJobPayload>(
  "sandbox-reset",
  { connection, defaultJobOptions: { attempts: 1 } },
);

export const sandboxResetQueueEvents = new QueueEvents("sandbox-reset", {
  connection,
});
