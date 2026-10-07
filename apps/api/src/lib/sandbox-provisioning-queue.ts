/**
 * One Queue instance per process for enqueuing — the worker holds the Worker
 * (apps/worker/src/sandbox-provisioning-worker.ts), matching the same split as
 * apps/api/src/lib/tenant-lifecycle.ts's tenantPurgeQueue.
 */
import { Queue } from "@platform/telemetry";
import { connection } from "./redis.js";

export interface SandboxProvisioningJobPayload {
  orgName: string;
  trialDays: number;
  requestedBy: string;
}

export const sandboxProvisioningQueue =
  new Queue<SandboxProvisioningJobPayload>("sandbox-provisioning", {
    connection,
    defaultJobOptions: { attempts: 1 },
  });
