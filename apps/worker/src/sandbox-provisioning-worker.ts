/**
 * sandbox-provisioning-worker.ts
 *
 * BullMQ processor for the "sandbox-provisioning" queue (docs/specs/multi-org-sandbox.md
 * T7). For each job:
 *  1. Create a Zitadel organization (retrying the name on conflict)
 *  2. Create the `tenants` row (is_sandbox=true, trial_ends_at, created_by_platform_admin,
 *     zitadel_org_id) via plain `db.insert`, same as
 *     apps/api/src/lib/tenant-lifecycle.ts's provisionTenant, since this tenant doesn't
 *     exist yet (no withTenantContext is possible until it does)
 *  3. Create 1 admin + 10-20 member accounts from the fixed org template, retrying each
 *     account's email on conflict
 *  4. Call runOrgDirectorySync() unmodified (R3) so the chart seeds with the admin at the
 *     top, under the synthetic root
 *  5. Audit the outcome (sandbox.provisioning_completed / .failed), once per job, the same
 *     way export-worker.ts audits export.completed/export.failed — not once per step. The
 *     tenant id is generated upfront (not left to the INSERT's defaultRandom())
 *     specifically so a failure in org creation or the tenant insert itself still has a
 *     stable id to audit under (security review finding — previously those two steps
 *     weren't audited on failure at all).
 *  6. (T8) Persist step-by-step progress to `sandbox_provisioning_jobs` as it happens, so
 *     the wait-screen (R5) can poll a row instead of the structured logs, and a failure
 *     partway through leaves a durable record of where it got to -- the row's own
 *     `current_step`/`completed_steps`/`total_steps`/`error` columns, not BullMQ's
 *     transient (and eventually evicted) job state.
 *  7. (T21) On success, store the handover artifact (seeded usernames + the shared
 *     password) in Redis with a 7-day TTL, NOT in `sandbox_provisioning_jobs` -- security
 *     review found a durable, ungated Postgres column here would hand every current and
 *     future platform_admin an indefinitely-valid credential dump. See
 *     packages/auth/src/sandbox-handover-store.ts.
 *  8. (T11) On ANY failure, automatically roll back: delete the Zitadel org if one was
 *     created (its v2 DeleteOrganization call cascades to delete every account created
 *     under it -- no per-account cleanup needed here), then delete the `tenants` row.
 *     Chosen over a retry (BullMQ's `attempts: 1` is deliberate -- see below) and over
 *     manual-only cleanup: a failed job should leave zero footprint by default. If the
 *     org deletion itself fails, the tenant row is deliberately left in place (not
 *     deleted) so it plus its `zitadel_org_id` remain as a manual-cleanup breadcrumb
 *     instead of orphaning a live Zitadel org with no local trace of it at all. The
 *     failure audit entry's `rolledBack` field records which case occurred.
 *
 * Deliberately NOT yet built here: T9 (module data seeding across workflow states --
 * scoped as a separate, larger follow-up; T10's automation-rule seeding already shipped
 * independently of it).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { Worker } from "@platform/telemetry";
import { db, tenants, sandboxProvisioningJobs } from "@platform/db";
import { eq } from "drizzle-orm";
import { writeAuditEntry } from "@platform/audit";
import {
  createOrg,
  deleteOrg,
  createHumanUser,
  generateSandboxOrgTemplate,
  nextEmailCandidate,
  storeSandboxHandoverCredentials,
  type SandboxAccountTemplate,
} from "@platform/auth";
import {
  runOrgDirectorySync,
  ZitadelOrgSourceImporter,
} from "@platform/org-directory";
import { logger } from "@platform/logger";
import { env } from "@platform/config";
import { connection } from "./queues.js";

const MAX_NAME_CONFLICT_ATTEMPTS = 5;
const MAX_ACCOUNT_CONFLICT_ATTEMPTS = 5;

export interface SandboxProvisioningJobPayload {
  orgName: string;
  trialDays: number;
  /** Zitadel user id of the platform_admin who requested this sandbox. */
  requestedBy: string;
}

export interface SandboxProvisioningJobResult {
  tenantId: string;
  zitadelOrgId: string;
  adminEmail: string;
  seededAccountCount: number;
  failedAccountCount: number;
}

type SandboxProvisioningJob = {
  /** BullMQ's own Job.id type is `string | undefined`, even though in practice the API
   * route always enqueues with an explicit `{ jobId }` matching the
   * `sandbox_provisioning_jobs.id` row it already inserted (see sandboxes.ts) -- kept
   * optional here only to stay assignable from a real `Job` without a cast; guarded at
   * the top of processSandboxProvisioningJob. */
  id?: string | undefined;
  data: SandboxProvisioningJobPayload;
};

async function updateJobProgress(
  jobId: string,
  patch: Partial<{
    status: "running" | "completed" | "failed";
    currentStep: string | null;
    completedSteps: number;
    totalSteps: number;
    resultTenantId: string;
    error: string;
  }>,
): Promise<void> {
  await db
    .update(sandboxProvisioningJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sandboxProvisioningJobs.id, jobId));
}

function sandboxEmailDomain(): string {
  // No dedicated env var for this yet — ZITADEL_ISSUER's hostname is already the one
  // real, always-configured domain this process knows about.
  try {
    return new URL(env.ZITADEL_ISSUER).hostname;
  } catch {
    return "sandbox.local";
  }
}

/**
 * Meets Zitadel's default password policy (min length, upper/lower/digit/symbol) without
 * needing T5's still-open policy spike resolved first — generous on every character class
 * so it clears whatever the actual configured policy turns out to require.
 */
function generateSandboxPassword(): string {
  const randomSegment = randomBytes(9).toString("base64url");
  return `Ow-${randomSegment}-9!`;
}

async function createAccountWithRetry(
  orgId: string,
  template: SandboxAccountTemplate,
  password: string,
  domain: string,
): Promise<{ userId: string; email: string } | null> {
  for (let attempt = 0; attempt < MAX_ACCOUNT_CONFLICT_ATTEMPTS; attempt++) {
    const email = nextEmailCandidate(template, domain, attempt);
    const result = await createHumanUser({
      orgId,
      email,
      givenName: template.givenName,
      familyName: template.familyName,
      password,
    });
    if (result.ok) return { userId: result.userId, email };
    if (!result.conflict) return null;
  }
  return null;
}

async function createOrgWithRetry(
  baseName: string,
): Promise<{ orgId: string; name: string } | null> {
  for (let attempt = 0; attempt < MAX_NAME_CONFLICT_ATTEMPTS; attempt++) {
    const name =
      attempt === 0
        ? baseName
        : `${baseName}-${Math.floor(1000 + Math.random() * 9000)}`;
    const result = await createOrg(name);
    if (result.ok) return { orgId: result.orgId, name };
    if (!result.conflict) return null;
  }
  return null;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
}

async function auditOutcome(
  job: SandboxProvisioningJob,
  tenantId: string,
  action: "sandbox.provisioning_completed" | "sandbox.provisioning_failed",
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeAuditEntry(db, {
    tenantId,
    actorId: job.data.requestedBy,
    actorType: "user",
    resourceType: "tenant",
    resourceId: tenantId,
    action,
    metadata: { jobId: job.id, ...metadata },
  });
}

export async function processSandboxProvisioningJob(
  job: SandboxProvisioningJob,
): Promise<SandboxProvisioningJobResult> {
  const { orgName, trialDays, requestedBy } = job.data;
  const jobId = job.id;
  if (!jobId) {
    throw new Error("SANDBOX_PROVISIONING_JOB_MISSING_ID");
  }

  logger.info({ orgName, jobId }, "sandbox provisioning job started");

  // Generated upfront (not left to the INSERT's defaultRandom()) so a stable id exists
  // to audit under even if org creation or the tenant insert itself is what fails --
  // security review finding: the audit-failure path previously only wrapped the code
  // AFTER the tenant row existed, so an org-creation or tenant-insert failure (e.g. a
  // transient Zitadel 5xx, or a slug collision) left behind a live Zitadel org with zero
  // audit trace at all. admin_audit_log.tenant_id has no FK constraint, so auditing under
  // this id is safe even on the path where the tenant row never ends up existing.
  const tenantId = randomUUID();
  let zitadelOrgId: string | undefined;
  let tenantInserted = false;

  // Generated upfront so totalSteps (org + tenant + 1-per-account + sync) is known before
  // the first progress write -- the wait-screen (R5) needs a real denominator from the
  // start, not one that grows mid-poll as accounts are discovered.
  const template = generateSandboxOrgTemplate();
  const domain = sandboxEmailDomain();
  const defaultPassword = generateSandboxPassword();
  const totalSteps = template.members.length + 4; // org, tenant, admin, members..., sync

  try {
    await updateJobProgress(jobId, {
      status: "running",
      currentStep: "creating_org",
      totalSteps,
      completedSteps: 0,
    });

    const org = await createOrgWithRetry(orgName);
    if (!org) {
      throw new Error("SANDBOX_ORG_CREATE_FAILED");
    }
    zitadelOrgId = org.orgId;
    await updateJobProgress(jobId, {
      currentStep: "creating_tenant",
      completedSteps: 1,
    });

    const now = new Date();
    const trialEndsAt = new Date(
      now.getTime() + trialDays * 24 * 60 * 60 * 1000,
    );

    const [tenantRow] = await db
      .insert(tenants)
      .values({
        id: tenantId,
        name: orgName,
        slug: slugify(orgName),
        status: "active",
        zitadelOrgId: org.orgId,
        isSandbox: true,
        trialEndsAt,
        createdByPlatformAdmin: requestedBy,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tenants.id });

    if (!tenantRow) {
      throw new Error("SANDBOX_TENANT_INSERT_FAILED");
    }
    tenantInserted = true;
    await updateJobProgress(jobId, {
      currentStep:
        "creating accounts (1/" + (template.members.length + 1) + ")",
      completedSteps: 2,
      resultTenantId: tenantId,
    });

    const admin = await createAccountWithRetry(
      org.orgId,
      template.admin,
      defaultPassword,
      domain,
    );
    if (!admin) {
      throw new Error("SANDBOX_ADMIN_ACCOUNT_CREATE_FAILED");
    }

    const seededAccounts: { email: string; role: "admin" | "member" }[] = [
      { email: admin.email, role: "admin" },
    ];
    let seededAccountCount = 1;
    let failedAccountCount = 0;
    for (const [index, member] of template.members.entries()) {
      const account = await createAccountWithRetry(
        org.orgId,
        member,
        defaultPassword,
        domain,
      );
      if (account) {
        seededAccountCount++;
        seededAccounts.push({ email: account.email, role: "member" });
      } else {
        failedAccountCount++;
        logger.warn(
          { tenantId, orgId: org.orgId, member: member.emailLocalPart },
          "sandbox provisioning: member account creation failed after retries — continuing",
        );
      }
      await updateJobProgress(jobId, {
        currentStep: `creating accounts (${index + 2}/${template.members.length + 1})`,
        completedSteps: 2 + index + 1,
      });
    }

    await updateJobProgress(jobId, {
      currentStep: "syncing_directory",
      completedSteps: totalSteps - 1,
    });

    const syncResult = await runOrgDirectorySync(
      tenantId,
      new ZitadelOrgSourceImporter(),
      requestedBy,
    );

    logger.info(
      {
        tenantId,
        orgId: org.orgId,
        jobId: jobId,
        seededAccountCount,
        failedAccountCount,
        syncStatus: syncResult.status,
      },
      "sandbox provisioning job completed",
    );

    // Credentials go to Redis (7-day TTL), never this table -- see module doc comment.
    // Review finding (PR #804): this is also why defaultPassword is never part of this
    // function's return value below -- BullMQ's removeOnComplete would otherwise persist
    // it a second time, in Redis's job-result store, with no gating at all. This dedicated
    // handover store (behind requirePlatformAdmin + MFA + the handover route's own status
    // check) is the only place it's retrievable from.
    await storeSandboxHandoverCredentials(tenantId, {
      seededAccounts,
      defaultPassword,
    });

    await updateJobProgress(jobId, {
      status: "completed",
      currentStep: null,
      completedSteps: totalSteps,
    });

    await auditOutcome(job, tenantId, "sandbox.provisioning_completed", {
      zitadelOrgId: org.orgId,
      seededAccountCount,
      failedAccountCount,
    });

    return {
      tenantId,
      zitadelOrgId: org.orgId,
      adminEmail: admin.email,
      seededAccountCount,
      failedAccountCount,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "UNKNOWN";
    await updateJobProgress(jobId, { status: "failed", error: message }).catch(
      (updateErr: unknown) => {
        logger.error(
          { err: updateErr, jobId: jobId },
          "sandbox provisioning job: failed to persist failure progress",
        );
      },
    );

    // T11: automatic rollback. deleteOrg cascades to delete all of the org's accounts
    // in one call (confirmed against Zitadel's v2 API docs), so there is no per-account
    // cleanup step here. The tenants row is only deleted AFTER a successful org deletion
    // (or when no org was ever created) -- if org deletion itself fails, the tenant row
    // and its zitadelOrgId are deliberately left in place as the pre-existing
    // manual-cleanup breadcrumb (the audit entry below), rather than destroying that
    // trail while a live, orphaned Zitadel org still exists.
    let rolledBack = true;
    if (zitadelOrgId) {
      const orgDeleted = await deleteOrg(zitadelOrgId).catch((err: unknown) => {
        logger.error(
          { err, zitadelOrgId, tenantId },
          "sandbox provisioning rollback: failed to delete Zitadel org",
        );
        return false;
      });
      if (!orgDeleted) {
        rolledBack = false;
        logger.error(
          { zitadelOrgId, tenantId, jobId },
          "sandbox provisioning rollback: org deletion failed -- tenant row left in place for manual cleanup",
        );
      }
    }
    if (rolledBack && tenantInserted) {
      await db
        .delete(tenants)
        .where(eq(tenants.id, tenantId))
        .catch((deleteErr: unknown) => {
          rolledBack = false;
          logger.error(
            { err: deleteErr, tenantId, jobId },
            "sandbox provisioning rollback: failed to delete tenant row",
          );
        });
    }

    await auditOutcome(job, tenantId, "sandbox.provisioning_failed", {
      zitadelOrgId: zitadelOrgId ?? null,
      error: message,
      rolledBack,
    }).catch((auditErr: unknown) => {
      logger.error(
        { err: auditErr, tenantId, jobId: jobId },
        "sandbox provisioning job: failed to audit failure",
      );
    });
    throw err;
  }
}

export const sandboxProvisioningWorker = new Worker<
  SandboxProvisioningJobPayload,
  SandboxProvisioningJobResult
>("sandbox-provisioning", (job) => processSandboxProvisioningJob(job), {
  connection,
  concurrency: 1,
  removeOnComplete: { age: 3_600 },
  removeOnFail: { age: 604_800 },
});

export function stopSandboxProvisioningWorker(): Promise<void> {
  return sandboxProvisioningWorker.close();
}
