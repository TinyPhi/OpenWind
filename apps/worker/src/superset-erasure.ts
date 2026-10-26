/**
 * superset-erasure.ts
 *
 * BullMQ processor for the "superset-erasure" queue (#728, slice 3 of
 * docs/specs/superset-gdpr-erasure.md).
 *
 * Superset keeps its own metadata database: a user's queries, saved queries, activity log, name,
 * email and an active account. The platform cannot reach it, so Superset erases its own data behind
 * `POST /openwind/erasure/{user,tenant}` (docker/superset/superset_config.py). This worker logs in as
 * the Superset service account, calls that endpoint again until it says it has finished, and
 * records the outcome as a `superset_erasure.completed` audit row. If Superset is down or the call
 * fails it retries for about 26 hours, then writes one `superset_erasure.failed` row and raises the
 * SupersetErasureFailed alert. Running it again is safe: a finished erasure matches nobody.
 *
 * Who asked, and when, is the platform's own `deleted` / `purge.completed` row. These rows are written
 * by the system and carry the same tenant, resourceType and resourceId, so one search by resource
 * shows both. They hold counts only: no name, email or SQL.
 */

import { z } from "zod";
import { UnrecoverableError } from "bullmq";
import { Worker, supersetErasureTotal } from "@platform/telemetry";
import { env, supersetErasureMode } from "@platform/config";
import { logger } from "@platform/logger";
import { withTenantContext } from "@platform/db";
import { writeAuditEntry, auditResourceId } from "@platform/audit";
import { connection, supersetErasureQueue } from "./queues.js";
import {
  SUPERSET_ERASURE_ATTEMPTS,
  supersetErasureBackoff,
} from "./superset-erasure-options.js";

export { SUPERSET_ERASURE_ATTEMPTS, supersetErasureBackoff };

// Superset's own limits: a call does about 20 s of work and returns `more` until it is finished, so
// this only stops a job that is not making progress from looping for ever.
export const MAX_CALLS_PER_ATTEMPT = 500;
const LOGIN_TIMEOUT_MS = 15_000;
const ERASE_TIMEOUT_MS = 60_000;

const SUBJECT_PATTERN = /^[A-Za-z0-9_.:@-]{1,255}$/;

const SummarySchema = z.object({
  matchedUsers: z.number().int().nonnegative(),
  heldUsers: z.number().int().nonnegative(),
  deletedRows: z.number().int().nonnegative(),
  cacheKeysRemoved: z.number().int().nonnegative(),
  calls: z.number().int().positive(),
});
export type SupersetErasureSummary = z.infer<typeof SummarySchema>;

const JobSchema = z
  .object({
    kind: z.enum(["user", "tenant"]),
    tenantId: z.string().uuid(),
    subject: z.string().regex(SUBJECT_PATTERN).optional(),
    // Kept on the job once Superset has answered, so a retry after a failed audit write reuses the
    // counts instead of recording the zero a second run reports.
    result: SummarySchema.optional(),
  })
  .refine((j) => (j.kind === "user") === (j.subject !== undefined), {
    message: "a user job needs a subject and a tenant job must not have one",
  });
export type SupersetErasureJob = z.infer<typeof JobSchema>;

const ReplySchema = z.object({
  matchedUsers: z.number().int().nonnegative(),
  heldUsers: z.number().int().nonnegative().default(0),
  deletedRows: z.number().int().nonnegative(),
  cacheKeysRemoved: z.number().int().nonnegative().default(0),
  more: z.boolean(),
});

interface SupersetSession {
  accessToken: string;
  csrfToken: string;
  cookie: string;
}

function supersetUrl(path: string): string {
  return `${env.SUPERSET_INTERNAL_URL.replace(/\/$/, "")}${path}`;
}

/**
 * Logs in as the service account and fetches a CSRF token with the session cookie it belongs to,
 * as apps/api/src/routes/reporting/superset-client.ts does. That client is not imported: the
 * dependency rule keeps apps/worker from importing apps/api.
 */
async function openSession(): Promise<SupersetSession> {
  if (!env.SUPERSET_SERVICE_ACCOUNT_PASSWORD) {
    throw new Error("SUPERSET_SERVICE_ACCOUNT_PASSWORD is not set");
  }
  const login = await fetch(supersetUrl("/api/v1/security/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: env.SUPERSET_SERVICE_ACCOUNT_USER,
      password: env.SUPERSET_SERVICE_ACCOUNT_PASSWORD,
      provider: "db",
      refresh: false,
    }),
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
  });
  // The body is never logged: it can echo the submitted credential back.
  if (!login.ok) throw new Error(`Superset login failed with ${login.status}`);
  const { access_token: accessToken } = z
    .object({ access_token: z.string().min(1) })
    .parse(await login.json());

  const csrf = await fetch(supersetUrl("/api/v1/security/csrf_token/"), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
  });
  if (!csrf.ok) {
    throw new Error(`Superset CSRF token request failed with ${csrf.status}`);
  }
  const { result: csrfToken } = z
    .object({ result: z.string().min(1) })
    .parse(await csrf.json());
  // Only the name=value part of each cookie goes back, not its attributes.
  const cookie = csrf.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("Superset CSRF response had no session cookie");
  return { accessToken, csrfToken, cookie };
}

async function eraseOnce(
  session: SupersetSession,
  job: SupersetErasureJob,
): Promise<z.infer<typeof ReplySchema>> {
  const res = await fetch(
    supersetUrl(`/openwind/erasure/${job.kind === "user" ? "user" : "tenant"}`),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        "X-CSRFToken": session.csrfToken,
        Cookie: session.cookie,
      },
      body: JSON.stringify(
        job.kind === "user"
          ? { tenantId: job.tenantId, subject: job.subject }
          : { tenantId: job.tenantId },
      ),
      signal: AbortSignal.timeout(ERASE_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Superset erase call failed with ${res.status}`);
  return ReplySchema.parse(await res.json());
}

/** Calls Superset until it reports it has finished; returns the totals. */
export async function eraseInSuperset(
  job: SupersetErasureJob,
): Promise<SupersetErasureSummary> {
  const session = await openSession();
  const total = {
    matchedUsers: 0,
    heldUsers: 0,
    deletedRows: 0,
    cacheKeysRemoved: 0,
    calls: 0,
  };
  for (;;) {
    const reply = await eraseOnce(session, job);
    total.calls += 1;
    total.matchedUsers = Math.max(total.matchedUsers, reply.matchedUsers);
    total.heldUsers = Math.max(total.heldUsers, reply.heldUsers);
    total.deletedRows += reply.deletedRows;
    total.cacheKeysRemoved += reply.cacheKeysRemoved;
    if (!reply.more) return total;
    if (total.calls >= MAX_CALLS_PER_ATTEMPT) {
      throw new Error(
        `Superset erasure did not finish within ${MAX_CALLS_PER_ATTEMPT} calls`,
      );
    }
  }
}

// The platform row this one is linked to: `deleted` on the user (resource id from the Zitadel id,
// the same helper users.ts uses) or `purge.completed` on the tenant.
function auditTarget(job: SupersetErasureJob): {
  resourceType: "user" | "tenant";
  resourceId: string;
} {
  return job.kind === "user"
    ? {
        resourceType: "user",
        resourceId: auditResourceId(job.subject as string),
      }
    : { resourceType: "tenant", resourceId: job.tenantId };
}

async function recordCompleted(
  job: SupersetErasureJob,
  summary: SupersetErasureSummary,
  attempts: number,
): Promise<void> {
  const { resourceType, resourceId } = auditTarget(job);
  // Inside the tenant context: on plain `db` RLS rejects the insert for app_user.
  await withTenantContext(job.tenantId, (tx) =>
    writeAuditEntry(tx, {
      tenantId: job.tenantId,
      actorId: "system",
      actorType: "system",
      resourceType,
      resourceId,
      action: "superset_erasure.completed",
      metadata: { kind: job.kind, attempts, ...summary },
    }),
  );
}

async function recordFailed(
  job: SupersetErasureJob,
  attempts: number,
): Promise<void> {
  const { resourceType, resourceId } = auditTarget(job);
  await withTenantContext(job.tenantId, (tx) =>
    writeAuditEntry(tx, {
      tenantId: job.tenantId,
      actorId: "system",
      actorType: "system",
      resourceType,
      resourceId,
      action: "superset_erasure.failed",
      metadata: { kind: job.kind, attempts },
    }),
  );
}

export async function processSupersetErasure(job: {
  data: unknown;
  attemptsMade: number;
  updateData: (data: SupersetErasureJob) => Promise<void>;
}): Promise<void> {
  const parsed = JobSchema.safeParse(job.data);
  // A malformed job can never succeed, so it is not retried.
  if (!parsed.success) {
    throw new UnrecoverableError(
      `invalid superset-erasure job: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const data = parsed.data;

  let summary = data.result;
  if (!summary) {
    summary = await eraseInSuperset(data);
    await job.updateData({ ...data, result: summary });
  }
  await recordCompleted(data, summary, job.attemptsMade + 1);
  supersetErasureTotal.add(1, { outcome: "completed" });
  logger.info(
    { tenantId: data.tenantId, kind: data.kind, ...summary },
    "superset erasure completed",
  );
  if (summary.heldUsers > 0) {
    logger.warn(
      { tenantId: data.tenantId, heldUsers: summary.heldUsers },
      "superset erasure left accounts the subject holds in another tenant; they were not erased",
    );
  }
}

if (supersetErasureMode(env) === "full" && !env.SUPERSET_ERASURE_ENABLED) {
  // Stage 2 on means Superset holds user accounts, so the setting cannot turn the erasure off.
  logger.warn(
    "SUPERSET_ERASURE_ENABLED is false but Superset Stage 2 is on; Superset erasure stays on",
  );
}

// A counter only appears in Prometheus once it has a value, and increase() of a series that starts at
// 1 is 0, so the first failure of a process would never raise SupersetErasureFailed. Start both at 0.
supersetErasureTotal.add(0, { outcome: "completed" });
supersetErasureTotal.add(0, { outcome: "failed" });

export const supersetErasureWorker = new Worker<SupersetErasureJob>(
  "superset-erasure",
  (job) =>
    processSupersetErasure({
      data: job.data,
      attemptsMade: job.attemptsMade,
      updateData: (data) => job.updateData(data),
    }),
  {
    connection,
    concurrency: 1,
    settings: {
      backoffStrategy: (attemptsMade) => supersetErasureBackoff(attemptsMade),
    },
  },
);

supersetErasureWorker.on("failed", (job, err) => {
  if (!job) return;
  const finalAttempt =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? 1);
  const context = {
    tenantId: job.data.tenantId,
    kind: job.data.kind,
    attempt: job.attemptsMade,
    err: String(err),
  };
  if (!finalAttempt) {
    logger.warn(
      { ...context, retryInMs: supersetErasureBackoff(job.attemptsMade) },
      "superset erasure attempt failed; it will be retried",
    );
    return;
  }
  logger.error(
    context,
    "superset erasure failed on its last attempt; follow docs/runbooks/superset-erasure.md",
  );
  supersetErasureTotal.add(1, { outcome: "failed" });
  const parsed = JobSchema.safeParse(job.data);
  // Nothing to link an audit row to when the job itself is malformed.
  if (!parsed.success) return;
  void recordFailed(parsed.data, job.attemptsMade).catch(
    (auditErr: unknown) => {
      logger.error(
        { tenantId: job.data.tenantId, err: String(auditErr) },
        "superset erasure: failed to write the failure audit entry",
      );
    },
  );
});

/**
 * One job per erasure: the id is the same every time for the same user or tenant, so a repeat while
 * the job is still queued or running does not run twice. The subject goes through auditResourceId
 * because BullMQ ids cannot contain ":" and a subject may.
 */
export function supersetErasureJobId(
  job: Pick<SupersetErasureJob, "kind" | "tenantId" | "subject">,
): string {
  return job.kind === "user"
    ? `superset-erasure-user-${job.tenantId}-${auditResourceId(job.subject as string)}`
    : `superset-erasure-tenant-${job.tenantId}`;
}

/**
 * Queues the erasure of one user's, or a purged tenant's, data in Superset, after the platform has
 * erased them. Only when Stage 2 is on: with it off, Superset holds no user accounts and only the
 * cache flush runs. Never throws: the erasure has already committed, and a failed enqueue must not
 * undo it. BullMQ ignores an add whose id already exists, so a finished or failed job with the same
 * id is removed first; one still queued or running is left to finish.
 */
export async function enqueueSupersetErasure(
  job: Pick<SupersetErasureJob, "kind" | "tenantId" | "subject">,
): Promise<boolean> {
  if (supersetErasureMode(env) !== "full") return false;
  try {
    const jobId = supersetErasureJobId(job);
    const existing = await supersetErasureQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== "failed" && state !== "completed") {
        logger.info(
          { tenantId: job.tenantId, kind: job.kind, state },
          "superset erasure already queued; not queued again",
        );
        return true;
      }
      await existing.remove();
    }
    await supersetErasureQueue.add(
      "erase",
      { kind: job.kind, tenantId: job.tenantId, subject: job.subject },
      { jobId },
    );
    return true;
  } catch (err) {
    logger.error(
      { tenantId: job.tenantId, kind: job.kind, err },
      "superset erasure could not be queued; run it by hand (docs/runbooks/superset-erasure.md)",
    );
    return false;
  }
}

export function stopSupersetErasureWorker(): Promise<void> {
  return supersetErasureWorker.close();
}
