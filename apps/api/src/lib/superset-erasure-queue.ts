import { Queue, supersetErasureTotal } from "@platform/telemetry";
import { env, supersetErasureMode } from "@platform/config";
import { logger } from "@platform/logger";
import { auditResourceId } from "@platform/audit";
import { connection } from "./redis.js";
import { SUPERSET_ERASURE_JOB_OPTIONS } from "./superset-erasure-options.js";

export interface SupersetErasureRequest {
  kind: "user" | "tenant";
  tenantId: string;
  /** The Zitadel user id; required for kind "user", absent for "tenant". */
  subject?: string;
}

// Same queue name as apps/worker/src/queues.ts, which owns the consumer and the retry rules. The
// options repeat the worker's: the queue that adds a job sets them.
export const supersetErasureQueue = new Queue("superset-erasure", {
  connection,
  defaultJobOptions: { ...SUPERSET_ERASURE_JOB_OPTIONS },
});

// Starts at 0 so the first failed enqueue of a process still moves increase() (SupersetErasureFailed).
supersetErasureTotal.add(0, { outcome: "not_queued" });

/**
 * Queues the erasure of a user's data in Superset (#728). Only when Superset Stage 2 is on: with
 * it off, Superset holds no user accounts and the cache flush alone covers it
 * (docs/specs/superset-gdpr-erasure.md, D8). Never throws: the platform erasure has already
 * committed, and a failed enqueue must not fail it. BullMQ ignores an add whose id already exists,
 * so a finished or failed job with the same id is removed first; one still queued or running is left
 * to finish. The id matches apps/worker/src/superset-erasure.ts (supersetErasureJobId).
 */
export async function enqueueSupersetErasure(
  request: SupersetErasureRequest,
): Promise<boolean> {
  if (supersetErasureMode(env) !== "full") return false;
  try {
    // BullMQ ids cannot contain ":", and a subject may, so it goes through auditResourceId.
    const jobId =
      request.kind === "user"
        ? `superset-erasure-user-${request.tenantId}-${auditResourceId(request.subject ?? "")}`
        : `superset-erasure-tenant-${request.tenantId}`;
    const existing = await supersetErasureQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== "failed" && state !== "completed") {
        logger.info(
          { tenantId: request.tenantId, kind: request.kind, state },
          "superset erasure already queued; not queued again",
        );
        return true;
      }
      await existing.remove().catch(async (removeErr: unknown) => {
        // Another request may have removed it a moment earlier and queued the fresh job.
        const state = await (
          await supersetErasureQueue.getJob(jobId)
        )?.getState();
        if (state === "failed" || state === "completed") throw removeErr;
      });
    }
    await supersetErasureQueue.add("erase", request, { jobId });
    return true;
  } catch (err) {
    supersetErasureTotal.add(1, { outcome: "not_queued" });
    logger.error(
      { tenantId: request.tenantId, kind: request.kind, err },
      "superset erasure could not be queued; run it by hand (docs/runbooks/superset-erasure.md)",
    );
    return false;
  }
}

/** What happened to the Superset part of a user erasure, for the API reply. */
export type SupersetErasureStatus =
  | "queued"
  | "not_member"
  | "cache_only"
  | "disabled"
  | "queue_failed";

export interface SupersetErasureOutcome {
  status: SupersetErasureStatus;
  /** True when SUPERSET_ERASURE_ENABLED is false but Stage 2 is on, so the erasure ran anyway. */
  switchIgnored: boolean;
  /** One plain sentence for the admin, fit for a toast. No names or ids. */
  message: string;
}

/**
 * The Superset part of erasing one user (#728), after the platform erasure has committed: queues
 * the Superset erasure when it applies, and says what happened so the caller can tell the admin.
 * Never throws.
 *
 * - Stage 2 on, member of this tenant: queued (also when the switch is off: it cannot turn the
 *   erasure off while Superset holds user accounts, spec D8).
 * - Stage 2 on, not a member: not queued, so an admin cannot reach a person outside their
 *   organisation through Superset.
 * - Stage 2 off: Superset holds no user accounts; the cache flush covers it, or nothing runs when
 *   SUPERSET_ERASURE_ENABLED is false.
 */
export async function eraseUserInSuperset(input: {
  tenantId: string;
  subject: string;
  wasMember: boolean;
}): Promise<SupersetErasureOutcome> {
  const mode = supersetErasureMode(env);
  if (mode === "off") {
    return {
      status: "disabled",
      switchIgnored: false,
      message:
        "Superset data was not erased because Superset erasure is disabled.",
    };
  }
  if (mode === "cache-only") {
    return {
      status: "cache_only",
      switchIgnored: false,
      message: env.SUPERSET_REDIS_URL
        ? "Superset sign-in is off, so Superset holds no account for this user; its cached results are being cleared."
        : "Superset sign-in is off, so Superset holds no account for this user; it has no cache to clear.",
    };
  }
  const switchIgnored = !env.SUPERSET_ERASURE_ENABLED;
  if (!input.wasMember) {
    logger.info(
      { tenantId: input.tenantId },
      "erased user was not a member of this tenant; Superset erasure not queued",
    );
    return {
      status: "not_member",
      switchIgnored,
      message:
        "Superset data was not erased because the user was not a member of this organisation.",
    };
  }
  if (switchIgnored) {
    logger.warn(
      { tenantId: input.tenantId },
      "SUPERSET_ERASURE_ENABLED is false but Superset Stage 2 is on; Superset erasure runs anyway",
    );
  }
  const queued = await enqueueSupersetErasure({
    kind: "user",
    tenantId: input.tenantId,
    subject: input.subject,
  });
  if (!queued) {
    return {
      status: "queue_failed",
      switchIgnored,
      message:
        "Superset data could not be scheduled for erasure; an operator must run it (see the Superset erasure runbook).",
    };
  }
  return {
    status: "queued",
    switchIgnored,
    message: switchIgnored
      ? "Superset erasure is disabled, but it ran because Superset sign-in is on: the user's Superset data is being erased."
      : "The user's Superset data is being erased.",
  };
}
