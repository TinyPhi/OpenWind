/**
 * One Queue instance per process for enqueuing — the worker holds the Worker
 * (apps/worker/src/sandbox-delete-worker.ts), matching the same split as
 * apps/api/src/lib/sandbox-reset-queue.ts. A QueueEvents instance is kept here so the
 * delete route can `await job.waitUntilFinished(sandboxDeleteQueueEvents)` and respond to
 * the platform admin only once the worker has removed the Zitadel org and initiated
 * OpenWind-side deletion.
 */
import { Queue, QueueEvents } from "bullmq";
import { connection } from "./redis.js";

export interface SandboxDeleteJobPayload {
  tenantId: string;
  requestedBy: string;
}

export const sandboxDeleteQueue = new Queue<SandboxDeleteJobPayload>(
  "sandbox-delete",
  { connection, defaultJobOptions: { attempts: 1 } },
);

export const sandboxDeleteQueueEvents = new QueueEvents("sandbox-delete", {
  connection,
});
