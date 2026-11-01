/**
 * superset-erasure-selfcheck.ts
 *
 * Stops Superset erasure degrading to "cache only" without anyone knowing (#1137, #728). Superset
 * decides whether Stage 2 (per-user accounts) is on from its own SUPERSET_OAUTH_CLIENT_ID; the API
 * and the worker decide separately from SUPERSET_DEPLOYMENT and theirs, and nothing compared the
 * three. A BullMQ repeatable job (one run per SUPERSET_SELFCHECK_INTERVAL_MINUTES, whatever the
 * number of worker replicas) asks Superset what it thinks, compares that with supersetErasureMode(),
 * runs a no-op erase for a tenant that cannot exist (proving the route, CSRF, role, DB access and
 * schema work), and keeps the answer in Redis for SUPERSET_SELFCHECK_TTL_MINUTES. The API and the
 * tenant purge read it: Superset saying Stage 2 is on makes them erase fully whatever their own env
 * says, and no fresh answer leaves a "cache-only" service unable to claim Superset holds nothing
 * ("unverified").
 *
 * With SUPERSET_DEPLOYMENT=off no Superset is expected: the check records "skipped" and raises
 * nothing, unless Superset answers and reports Stage 2 on (the safety net: "mismatch").
 *
 * It writes no audit row and no database row, and touches no tenant data: the synthetic tenant holds
 * no accounts, so the erase matches nobody.
 */

import { z } from "zod";
import { env, supersetErasureMode } from "@platform/config";
import type { SupersetErasureMode } from "@platform/config";
import { logger } from "@platform/logger";
import { Queue, Worker } from "@platform/telemetry";
import { supersetErasureSelfcheckTotal } from "@platform/telemetry";
import {
  readSupersetSelfcheck,
  writeSupersetSelfcheck,
  type SupersetSelfcheckOutcome,
  type SupersetSelfcheckResult,
} from "@platform/redis";
import { connection } from "./queues.js";
import {
  eraseOnce,
  openSession,
  supersetUrl,
  type SupersetSession,
} from "./superset-erasure.js";

export const SELFCHECK_QUEUE_NAME = "superset-erasure-selfcheck";
export const SELFCHECK_REPEAT_JOB_ID = "superset-erasure-selfcheck-recurring";
export const SELFCHECK_START_JOB_ID = "superset-erasure-selfcheck-on-start";
const STATUS_TIMEOUT_MS = 15_000;

/** A v4-shaped uuid no tenant can have: the erase finds no role for it. */
export const SMOKE_TENANT_ID = "00000000-0000-4000-8000-00000000de1e";

const StatusSchema = z.object({
  stage2: z.boolean(),
  erasure: z.boolean(),
  owsubMarker: z.boolean(),
  version: z.string(),
});
export type SupersetStatus = z.infer<typeof StatusSchema>;

export interface EnablementComparison {
  mismatch: boolean;
  reason: string | null;
}

/**
 * Superset's report against this service's setting. Stage 2 on in Superset with a local mode other
 * than "full" is the dangerous direction (erasure would only flush the cache). The reverse is
 * harmless for erasure, since the job still runs, but it is drift that will bite on the next
 * change, so it is flagged too.
 */
export function compareEnablement(
  status: Pick<SupersetStatus, "stage2">,
  local: SupersetErasureMode,
): EnablementComparison {
  const localStage2 = local === "full";
  if (status.stage2 === localStage2) return { mismatch: false, reason: null };
  return {
    mismatch: true,
    reason: status.stage2
      ? `Superset has Stage 2 on but this service's mode is "${local}" (SUPERSET_DEPLOYMENT=on and SUPERSET_OAUTH_CLIENT_ID must both be set here)`
      : `this service has SUPERSET_DEPLOYMENT=on and SUPERSET_OAUTH_CLIENT_ID set but Superset has Stage 2 off`,
  };
}

async function fetchStatus(session: SupersetSession): Promise<SupersetStatus> {
  const res = await fetch(supersetUrl("/openwind/erasure/status"), {
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "X-CSRFToken": session.csrfToken,
      Cookie: session.cookie,
    },
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new Error(`Superset status call failed with ${res.status}`);
  return StatusSchema.parse(await res.json());
}

/** The smoke erase must match nobody and delete nothing. Anything else is a failure. */
async function smokeErase(session: SupersetSession): Promise<void> {
  const reply = await eraseOnce(session, {
    kind: "user",
    tenantId: SMOKE_TENANT_ID,
    subject: `smoke-${crypto.randomUUID()}`,
  });
  if (
    reply.matchedUsers !== 0 ||
    reply.heldUsers !== 0 ||
    reply.deletedRows !== 0 ||
    reply.more
  ) {
    throw new Error("smoke erase for the synthetic tenant was not a no-op");
  }
}

/** One self-check. Never throws; the result is also what it recorded. */
export async function runSupersetSelfcheck(
  now: () => number = Date.now,
): Promise<SupersetSelfcheckResult> {
  const local = supersetErasureMode(env);
  const finish = async (
    outcome: SupersetSelfcheckOutcome,
    stage2: boolean | null,
    mismatch: boolean,
  ): Promise<SupersetSelfcheckResult> => {
    const result = { checkedAt: now(), outcome, stage2, mismatch };
    supersetErasureSelfcheckTotal.add(1, { outcome });
    try {
      await writeSupersetSelfcheck(result);
    } catch (err) {
      logger.error(
        { err: String(err) },
        "superset self-check: result could not be stored; the API and purge will treat Superset as unverified",
      );
    }
    return result;
  };

  // With the flag off a failure to ask is "skipped", but it must not erase an earlier report that
  // Superset has Stage 2 on: that report is what keeps erasure running while the flag is wrong. Keep
  // it alive as "unreachable" (stage2 still true) for as long as Superset cannot be asked.
  const skippedUnlessKnownOn = async (): Promise<SupersetSelfcheckResult> => {
    const previous = await readSupersetSelfcheck();
    if (previous?.stage2 === true) {
      logger.error(
        {},
        "superset self-check: Superset could not be asked, and it last reported Stage 2 on; keeping that (SUPERSET_DEPLOYMENT is off here, docs/runbooks/superset-erasure.md)",
      );
      return finish("unreachable", true, true);
    }
    return finish("skipped", null, false);
  };

  // Off: nothing is expected. Any failure to ask is "skipped"; only Superset itself saying Stage 2 is
  // on matters (the safety net).
  let session: SupersetSession;
  try {
    session = await openSession();
  } catch (err) {
    if (local === "off") {
      logger.info(
        { err: String(err) },
        "superset self-check skipped: SUPERSET_DEPLOYMENT is off and Superset is not reachable",
      );
      return skippedUnlessKnownOn();
    }
    logger.error(
      { err: String(err), mode: local },
      "superset self-check: Superset could not be reached; erasure cannot be verified (docs/runbooks/superset-erasure.md)",
    );
    return finish("unreachable", null, false);
  }

  let status: SupersetStatus;
  try {
    status = await fetchStatus(session);
  } catch (err) {
    if (local === "off") {
      logger.info(
        { err: String(err) },
        "superset self-check skipped: SUPERSET_DEPLOYMENT is off and Superset's status could not be read",
      );
      return skippedUnlessKnownOn();
    }
    logger.error(
      { err: String(err) },
      "superset self-check: the status route failed; is the Superset image current? (docs/runbooks/superset-erasure.md)",
    );
    return finish("smoke_failed", null, false);
  }

  if (local === "off" && !status.stage2) {
    logger.info(
      {},
      "superset self-check skipped: SUPERSET_DEPLOYMENT is off and Superset has Stage 2 off",
    );
    return finish("skipped", false, false);
  }

  const comparison = compareEnablement(status, local);
  if (comparison.mismatch) {
    logger.error(
      { mode: local, supersetStage2: status.stage2 },
      `superset self-check: Superset and this platform disagree on Stage 2: ${comparison.reason}`,
    );
  }

  if (local === "off") return finish("mismatch", status.stage2, true);

  try {
    if (!status.erasure)
      throw new Error("Superset reports erasure is not available");
    await smokeErase(session);
  } catch (err) {
    logger.error(
      { err: String(err) },
      "superset self-check: the smoke erase failed (docs/runbooks/superset-erasure.md)",
    );
    return finish("smoke_failed", status.stage2, comparison.mismatch);
  }

  if (comparison.mismatch) return finish("mismatch", status.stage2, true);
  logger.info(
    { mode: local, supersetStage2: status.stage2, version: status.version },
    "superset self-check ok",
  );
  return finish("ok", status.stage2, false);
}

/** Counters start at 0 so the first outcome of a process still moves increase() in the alert rules. */
function seedMetrics(): void {
  for (const outcome of [
    "ok",
    "mismatch",
    "smoke_failed",
    "unreachable",
    "skipped",
  ] as const) {
    supersetErasureSelfcheckTotal.add(0, { outcome });
  }
}
seedMetrics();

export const supersetErasureSelfcheckWorker = new Worker(
  SELFCHECK_QUEUE_NAME,
  async () => {
    await runSupersetSelfcheck();
  },
  { connection },
);

supersetErasureSelfcheckWorker.on("failed", (_job, err) => {
  logger.error({ err: String(err) }, "superset self-check: worker job failed");
});

/**
 * Registers the repeatable job (fixed job id, so the key is the same on every worker replica and
 * on every restart: one run per interval in total) plus one run at startup. A changed interval gets
 * a different repeat key, so earlier registrations are removed first or both would keep firing.
 * Idempotent.
 */
export async function scheduleSupersetErasureSelfcheck(): Promise<void> {
  const everyMs = env.SUPERSET_SELFCHECK_INTERVAL_MINUTES * 60_000;
  const queue = new Queue(SELFCHECK_QUEUE_NAME, { connection });
  try {
    for (const job of await queue.getRepeatableJobs()) {
      if (job.name === "check" && job.every !== String(everyMs)) {
        await queue.removeRepeatableByKey(job.key);
      }
    }
    await queue.add(
      "check",
      {},
      {
        repeat: { every: everyMs },
        jobId: SELFCHECK_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
    await queue.add(
      "check-on-start",
      {},
      {
        jobId: SELFCHECK_START_JOB_ID,
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  } finally {
    await queue.close();
  }
  logger.info(
    { everyMinutes: env.SUPERSET_SELFCHECK_INTERVAL_MINUTES },
    "superset self-check: scheduled (repeatable job and once at start)",
  );
}

export async function stopSupersetErasureSelfcheck(): Promise<void> {
  await supersetErasureSelfcheckWorker.close();
}
