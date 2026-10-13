import { sql } from "drizzle-orm";
import { db } from "./client.js";
import {
  recordPlatformAdminAction,
  type PlatformAdminAction,
} from "./platform-admin-audit.js";
import type { DbOrTx } from "./middleware.js";

/**
 * Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md R2, T19). Spec-review finding B1:
 * "no business data is returned to platform_admin" must be a structural property of the
 * response shape, not a habit every future route author has to remember. Every
 * `platform_admin`-reachable route (packages/auth's requirePlatformAdmin) returns data
 * through this type, built only by toPlatformAdminSandboxView below -- never a direct
 * passthrough of a Drizzle query result, which could carry any column the author happened
 * to select, including ones added to `tenants` later for unrelated reasons.
 *
 * Deliberately excludes: config, plan, zitadelOrgId, status, suspendedAt,
 * deletionScheduledAt -- none of these are in R2's allowed metadata list, even though they
 * live on the same `tenants` row. Widening this type is itself the explicit, reviewable act
 * that widening platform_admin's visibility requires.
 *
 * trialEndsAt was added for R6a (trial editing): the dashboard shows the current end date and
 * a countdown. It was already inside 0135's column grant.
 */
export interface PlatformAdminSandboxView {
  id: string;
  name: string;
  isSandbox: boolean;
  createdAt: string;
  trialStatus: "none" | "active" | "expired";
  trialEndsAt: string | null;
}

/** The only columns toPlatformAdminSandboxView reads -- matches the GRANT in 0135_platform_admin_sandbox_columns.sql exactly. */
export interface PlatformAdminSandboxRow {
  id: string;
  name: string;
  isSandbox: boolean;
  trialEndsAt: Date | null;
  createdAt: Date;
}

function trialStatus(
  trialEndsAt: Date | null,
): PlatformAdminSandboxView["trialStatus"] {
  if (!trialEndsAt) return "none";
  return trialEndsAt.getTime() > Date.now() ? "active" : "expired";
}

export function toPlatformAdminSandboxView(
  row: PlatformAdminSandboxRow,
): PlatformAdminSandboxView {
  return {
    id: row.id,
    name: row.name,
    isSandbox: row.isSandbox,
    createdAt: row.createdAt.toISOString(),
    trialStatus: trialStatus(row.trialEndsAt),
    trialEndsAt: row.trialEndsAt ? row.trialEndsAt.toISOString() : null,
  };
}

class SandboxTrialNotUpdated extends Error {}

/**
 * Runs one 0142 trial function as platform_admin_role with its R9 audit row in the same
 * transaction: the audit insert goes first (platform_admin_role can only SELECT the audit
 * table), then the role switch, then the function. A NULL result (nothing changed) rolls the
 * audit row back, so neither a change without its record nor a record without a change commits.
 */
async function runSandboxTrialFunction(
  tenantId: string,
  actorSub: string,
  action: Extract<
    PlatformAdminAction,
    "sandbox.trial_changed" | "sandbox.trial_ended"
  >,
  call: ReturnType<typeof sql>,
): Promise<Date | null> {
  try {
    return await db.transaction(async (tx) => {
      await recordPlatformAdminAction(
        { actorSub, action, targetTenantId: tenantId },
        tx,
      );
      await tx.execute(sql`SET LOCAL ROLE platform_admin_role`);
      const rows = await tx.execute<{ trial_ends_at: string | Date | null }>(
        call,
      );
      const value = rows[0]?.trial_ends_at;
      if (value === null || value === undefined) {
        throw new SandboxTrialNotUpdated();
      }
      return new Date(value);
    });
  } catch (err) {
    if (err instanceof SandboxTrialNotUpdated) return null;
    throw err;
  }
}

/**
 * R6a: extends a sandbox's trial by `days` from the later of its current end and now (an
 * expired or unset trial runs `days` from now, which reactivates it). The new end is computed
 * inside one UPDATE (0142), so concurrent extends stack. Only active `is_sandbox` rows are
 * touched, whatever id is passed. Returns the new end, or null when nothing changed.
 */
export async function extendSandboxTrial(
  tenantId: string,
  days: number,
  actorSub: string,
): Promise<Date | null> {
  return runSandboxTrialFunction(
    tenantId,
    actorSub,
    "sandbox.trial_changed",
    sql`SELECT platform_admin_extend_sandbox_trial(${tenantId}::uuid, ${days}::integer) AS trial_ends_at`,
  );
}

/**
 * R6a: ends a sandbox's running trial now. Only a trial that is currently active is ended --
 * never a sandbox with no trial or an already-expired one. Returns the new end, or null when
 * nothing changed.
 */
export async function endSandboxTrial(
  tenantId: string,
  actorSub: string,
): Promise<Date | null> {
  return runSandboxTrialFunction(
    tenantId,
    actorSub,
    "sandbox.trial_ended",
    sql`SELECT platform_admin_end_sandbox_trial(${tenantId}::uuid) AS trial_ends_at`,
  );
}

export interface SandboxQuotaCheck {
  allowed: boolean;
  current: number;
  limit: number;
}

/**
 * R11 (spec-review B2): caps how many concurrently-active (non-deleted) sandboxes a single
 * platform_admin can have open. "Deleted" sandboxes are rows removed entirely by T15 (no
 * soft-delete column on `tenants` for this), so every row with `created_by_platform_admin`
 * matching this actor currently counts toward their limit. The caller (T7's creation route)
 * must check this BEFORE provisioning any Zitadel org -- this function only counts existing
 * OpenWind rows, it does not reserve a slot, so the caller is still responsible for not
 * racing two concurrent creation requests from the same platform_admin past the limit.
 */
export async function checkSandboxQuota(
  tx: DbOrTx,
  platformAdminUserId: string,
  limit: number,
): Promise<SandboxQuotaCheck> {
  const rows = await tx.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM tenants
    WHERE is_sandbox AND created_by_platform_admin = ${platformAdminUserId}
  `);
  const current = Number(rows[0]?.count ?? "0");
  return { allowed: current < limit, current, limit };
}

// ── Provisioning job progress / handover (T8, T21) ──────────────────────────────────────

/**
 * R5's polled progress view. Deliberately excludes seededAccounts/defaultPassword (the T21
 * handover artifact) -- the progress endpoint is polled continuously while a job runs and
 * has no business reason to carry credentials; handover is a separate, explicit fetch
 * (toProvisioningHandoverView below) once the job is actually complete.
 */
export interface ProvisioningProgressView {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  currentStep: string | null;
  completedSteps: number;
  totalSteps: number;
  error: string | null;
}

export interface ProvisioningProgressRow {
  id: string;
  status: string;
  currentStep: string | null;
  completedSteps: number;
  totalSteps: number;
  error: string | null;
}

function asProgressStatus(status: string): ProvisioningProgressView["status"] {
  if (
    status === "pending" ||
    status === "running" ||
    status === "completed" ||
    status === "failed"
  )
    return status;
  // The DB CHECK constraint (migration 0137) already guarantees this is unreachable --
  // narrowing defensively here so the view's type stays a closed union rather than
  // widening to `string` the moment a route reads a row back.
  throw new Error(`unexpected sandbox_provisioning_jobs.status: ${status}`);
}

export function toProvisioningProgressView(
  row: ProvisioningProgressRow,
): ProvisioningProgressView {
  return {
    id: row.id,
    status: asProgressStatus(row.status),
    currentStep: row.currentStep,
    completedSteps: row.completedSteps,
    totalSteps: row.totalSteps,
    error: row.error,
  };
}

/**
 * T21's handover artifact shape -- the actual usernames + shared password a platform admin
 * hands to a prospect. Deliberately a SEPARATE type from ProvisioningProgressView (never
 * widen that one to carry credentials). Unlike the progress view, this isn't built from a
 * single DB row: the credentials live in Redis with a TTL, not in this table (security
 * review, migration 0137's comment) -- the route combines a DB status check (job exists and
 * is completed) with a Redis read (packages/auth's getSandboxHandoverCredentials) itself,
 * since packages/db has no reason to depend on packages/auth for a Redis-backed type.
 */
export interface ProvisioningHandoverView {
  tenantId: string;
  seededAccounts: { email: string; role: "admin" | "user" }[];
  defaultPassword: string;
}
