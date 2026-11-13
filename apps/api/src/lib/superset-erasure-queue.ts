import { Queue, supersetErasureTotal } from "@platform/telemetry";
import { env, supersetErasureMode } from "@platform/config";
import { logger } from "@platform/logger";
import { auditResourceId, writeAuditEntry } from "@platform/audit";
import { withTenantContext } from "@platform/db";
import {
  readSupersetSelfcheck,
  resolveSupersetErasureMode,
} from "@platform/redis";
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
supersetErasureTotal.add(0, { outcome: "unverified" });
supersetErasureTotal.add(0, { outcome: "reconciled" });

/**
 * Queues the erasure of a user's data in Superset (#728). Only when Superset Stage 2 is on: with
 * it off, Superset holds no user accounts and the cache flush alone covers it
 * (docs/specs/superset-gdpr-erasure.md, D8). Never throws: the platform erasure has already
 * committed, and a failed enqueue must not fail it. BullMQ ignores an add whose id already exists,
 * so a finished or failed job with the same id is removed first; one still queued or running is left
 * to finish. The id matches apps/worker/src/superset-erasure.ts (supersetErasureJobId). `force` is
 * for a caller that learned from Superset itself that Stage 2 is on while this process's own
 * SUPERSET_OAUTH_CLIENT_ID says otherwise (#1137).
 */
export async function enqueueSupersetErasure(
  request: SupersetErasureRequest,
  options: { force?: boolean } = {},
): Promise<boolean> {
  if (!options.force && supersetErasureMode(env) !== "full") return false;
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
  | "queue_failed"
  /** Superset's own state could not be confirmed, so nothing is known to have been erased there. */
  | "unverified";

export interface SupersetErasureOutcome {
  status: SupersetErasureStatus;
  /** True when SUPERSET_DEPLOYMENT is off here but Superset reports Stage 2 on, so the erasure ran anyway. */
  switchIgnored: boolean;
  /** One plain sentence for the admin, fit for a toast. No names or ids. */
  message: string;
}

/**
 * Leaves the durable trail the reconciler (#1138) works from when a user erase ends "unverified":
 * a `superset_erasure.failed` row (migration 0156) on the user, as the system, with
 * metadata.status "unverified" and the Zitadel user id (the platform's own `deleted` row holds it
 * too; the resource id is only its hash). A reconciler retries every such row that has no later
 * `superset_erasure.completed` row for the same resource once the self-check is green. Never throws.
 */
async function recordUnverifiedErasure(input: {
  tenantId: string;
  subject: string;
}): Promise<void> {
  try {
    await withTenantContext(input.tenantId, (tx) =>
      writeAuditEntry(tx, {
        tenantId: input.tenantId,
        actorId: "system",
        actorType: "system",
        resourceType: "user",
        resourceId: auditResourceId(input.subject),
        action: "superset_erasure.failed",
        metadata: {
          kind: "user",
          status: "unverified",
          userId: input.subject,
        },
      }),
    );
  } catch (err) {
    logger.error(
      { tenantId: input.tenantId, err: String(err) },
      "superset erasure unverified: the audit row for the reconciler could not be written; an operator must check Superset (docs/runbooks/superset-erasure.md)",
    );
  }
}

/**
 * The Superset part of erasing one user (#728), after the platform erasure has committed: queues
 * the Superset erasure when it applies, and says what happened so the caller can tell the admin.
 * Never throws.
 *
 * - SUPERSET_DEPLOYMENT=off: "disabled", unless Superset itself reports Stage 2 on (the worker
 *   self-check, #1137): then it is treated as on, fail closed, and the erasure is queued.
 * - Stage 2 on, member of this tenant: queued.
 * - Stage 2 on, not a member: not queued, so an admin cannot reach a person outside their
 *   organisation through Superset.
 * - Deployment on, Stage 2 off, confirmed by Superset's own report: Superset holds no user accounts;
 *   the cache flush covers it.
 * - Deployment on, this service says Stage 2 is off but Superset's state could not be confirmed (no
 *   fresh self-check result): "unverified", never the claim that Superset holds no account. A
 *   `superset_erasure.failed` audit row with status "unverified" is written for the reconciler.
 */
export async function eraseUserInSuperset(input: {
  tenantId: string;
  subject: string;
  wasMember: boolean;
}): Promise<SupersetErasureOutcome> {
  const localMode = supersetErasureMode(env);
  const { mode, verified, overridden } = resolveSupersetErasureMode(
    localMode,
    localMode === "full" ? null : await readSupersetSelfcheck(),
  );
  if (mode === "off") {
    return {
      status: "disabled",
      switchIgnored: false,
      message:
        "Superset data was not erased because Superset erasure is disabled.",
    };
  }
  if (mode === "cache-only" && !verified) {
    supersetErasureTotal.add(1, { outcome: "unverified" });
    logger.error(
      { tenantId: input.tenantId },
      "superset erasure unverified: Superset's Stage 2 state could not be confirmed and this service treats it as off; check docs/runbooks/superset-erasure.md",
    );
    await recordUnverifiedErasure(input);
    return {
      status: "unverified",
      switchIgnored: false,
      message:
        "The user's data was erased here, but it could not be confirmed whether Superset holds an account for them. An operator must check Superset (see the Superset erasure runbook).",
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
  const switchIgnored = overridden && localMode === "off";
  if (overridden) {
    logger.error(
      { tenantId: input.tenantId },
      "Superset reports Stage 2 is on but this service has SUPERSET_DEPLOYMENT off or no SUPERSET_OAUTH_CLIENT_ID; Superset erasure runs anyway (set both on every service, docs/runbooks/superset-erasure.md)",
    );
  }
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
  const queued = await enqueueSupersetErasure(
    {
      kind: "user",
      tenantId: input.tenantId,
      subject: input.subject,
    },
    { force: overridden },
  );
  if (!queued) {
    return {
      status: "queue_failed",
      switchIgnored,
      message:
        "Superset data could not be scheduled for erasure immediately; it will be retried automatically.",
    };
  }
  return {
    status: "queued",
    switchIgnored,
    message: switchIgnored
      ? "Superset erasure is disabled here, but it ran because Superset sign-in is on: the user's Superset data is being erased."
      : "The user's Superset data is being erased.",
  };
}
