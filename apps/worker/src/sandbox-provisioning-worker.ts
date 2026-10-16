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
 *  3b. (T9/T10) Install every core module's schema/workflow/automation-rule seed SQL
 *      (sandbox-module-install.ts -- duplicates apps/api/src/services/module-service.ts's
 *      ModuleService.installModule rather than importing it; apps/worker cannot import
 *      from apps/api), then seed a small fixed set of real records per module across its
 *      actual workflow states, driven through real executeTransition calls
 *      (sandbox-module-data-seed.ts). A failure in either step is caught per-module
 *      internally and does not fail the whole job -- a sandbox with some modules
 *      partially seeded is still useful, unlike a partially created org/tenant/accounts.
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
 */

import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { Worker } from "@platform/telemetry";
import {
  db,
  tenants,
  sandboxProvisioningJobs,
  withTenantLifecycleContext,
  recordPlatformAdminAction,
  withTenantContext,
  tenantUsers,
} from "@platform/db";
import { eq } from "drizzle-orm";
import { writeAuditEntry } from "@platform/audit";
import {
  createOrg,
  deleteOrg,
  createHumanUser,
  grantProjectToOrg,
  authorizeUser,
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
import { installCoreModulesForSandbox } from "./sandbox-module-install.js";
import { seedAllModulesData } from "./sandbox-module-data-seed.js";

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
    zitadelOrgId: string;
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
  domain: string,
): Promise<{
  userId: string;
  username: string;
  email: string;
  password: string;
} | null> {
  // One password per account, never shared across a sandbox's accounts.
  const password = generateSandboxPassword();
  for (let attempt = 0; attempt < MAX_ACCOUNT_CONFLICT_ATTEMPTS; attempt++) {
    const email = nextEmailCandidate(template, domain, attempt);
    // The username is the email's local part, so the two always match -- including the
    // suffixed candidate after a clash (usernames are instance-unique, like emails).
    const username = email.slice(0, email.indexOf("@"));
    const result = await createHumanUser({
      orgId,
      username,
      email,
      givenName: template.givenName,
      familyName: template.familyName,
      password,
    });
    if (result.ok) return { userId: result.userId, username, email, password };
    if (!result.conflict) return null;
  }
  return null;
}

/**
 * Registers the seeded accounts as members of the new tenant. tenant_users is otherwise only
 * filled when someone first signs in, so until then @mentions, access grants and anything else
 * that checks membership would skip them. (Those checks also consult the tenant's Zitadel org,
 * so a failure here is logged, not fatal.)
 */
async function registerTenantMembers(
  tenantId: string,
  members: { userId: string; email: string; displayName: string }[],
): Promise<void> {
  try {
    await withTenantContext(tenantId, (tx) =>
      tx
        .insert(tenantUsers)
        .values(members.map((m) => ({ tenantId, ...m })))
        .onConflictDoNothing(),
    );
  } catch (err) {
    // Not `err` itself: a failed insert's error carries its bound parameters -- the seeded
    // accounts' email addresses.
    const cause =
      err instanceof Error ? (err.cause as { code?: unknown }) : null;
    logger.warn(
      {
        tenantId,
        memberCount: members.length,
        errorCode: typeof cause?.code === "string" ? cause.code : "unknown",
      },
      "sandbox provisioning: could not register seeded accounts as tenant members -- they are still found through the Zitadel org",
    );
  }
}

async function createOrgWithRetry(
  baseName: string,
): Promise<{ orgId: string; name: string } | null> {
  for (let attempt = 0; attempt < MAX_NAME_CONFLICT_ATTEMPTS; attempt++) {
    const name =
      attempt === 0 ? baseName : `${baseName}-${randomInt(1000, 10000)}`;
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
  return `${base}-${randomInt(1000, 10000)}`;
}

async function auditOutcome(
  job: SandboxProvisioningJob,
  tenantId: string,
  action: "sandbox.provisioning_completed" | "sandbox.provisioning_failed",
  metadata: Record<string, unknown>,
): Promise<void> {
  // admin_audit_log is RLS-protected and the worker connects as app_user, so the write must
  // carry the tenant GUC -- on plain `db` the policy rejects it every time. Works even after
  // a rollback deleted the tenant row: the policy only compares tenant_id, there is no FK.
  await withTenantContext(tenantId, (tx) =>
    writeAuditEntry(tx, {
      tenantId,
      actorId: job.data.requestedBy,
      actorType: "user",
      resourceType: "tenant",
      resourceId: tenantId,
      action,
      metadata: { jobId: job.id, ...metadata },
    }),
  );
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
  const totalSteps = template.members.length + 5; // org, tenant, admin, members..., modules, sync

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

    // R3 sign-in: the OpenWind project belongs to the main org, and Zitadel refuses sign-in
    // (APP-asb43) for a user with no grant on it. Grant the project to the sandbox org first,
    // so every seeded account can be authorized on it below. Failing here rolls the sandbox
    // back -- a sandbox nobody can sign into is useless.
    await updateJobProgress(jobId, { currentStep: "granting_access" });
    if (!(await grantProjectToOrg(org.orgId))) {
      throw new Error("SANDBOX_PROJECT_GRANT_FAILED");
    }

    await updateJobProgress(jobId, {
      currentStep: "creating_tenant",
      completedSteps: 1,
    });

    const now = new Date();
    const trialEndsAt = new Date(
      now.getTime() + trialDays * 24 * 60 * 60 * 1000,
    );

    // app_user can't insert tenants (#405); tenant_lifecycle_role (migration 0143) can.
    const [tenantRow] = await withTenantLifecycleContext((tx) =>
      tx
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
        .returning({ id: tenants.id }),
    );

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
      domain,
    );
    if (!admin) {
      throw new Error("SANDBOX_ADMIN_ACCOUNT_CREATE_FAILED");
    }
    // The one admin gets the admin role; without it the handed-over account can't sign in.
    if (!(await authorizeUser(admin.userId, org.orgId, ["admin"]))) {
      throw new Error("SANDBOX_ADMIN_AUTHORIZATION_FAILED");
    }

    // Labelled with the Zitadel role each account was granted (admin / user), not the
    // template's internal "member" name, so the handover matches what the account can do.
    const seededAccounts: {
      username: string;
      email: string;
      role: "admin" | "user";
      password: string;
    }[] = [
      {
        username: admin.username,
        email: admin.email,
        role: "admin",
        password: admin.password,
      },
    ];
    // Also the round-robin set for seeded records (admin first).
    const members = [
      {
        userId: admin.userId,
        email: admin.email,
        displayName: `${template.admin.givenName} ${template.admin.familyName}`,
      },
    ];
    let seededAccountCount = 1;
    let failedAccountCount = 0;
    for (const [index, member] of template.members.entries()) {
      const account = await createAccountWithRetry(org.orgId, member, domain);
      // Every other seeded account is a plain user. One that can't be authorized can't sign
      // in either, so it counts as failed (and is left out of the handover list) rather than
      // failing the whole sandbox.
      const authorized =
        account !== null &&
        (await authorizeUser(account.userId, org.orgId, ["user"]));
      if (account && authorized) {
        seededAccountCount++;
        members.push({
          userId: account.userId,
          email: account.email,
          displayName: `${member.givenName} ${member.familyName}`,
        });
        seededAccounts.push({
          username: account.username,
          email: account.email,
          role: "user",
          password: account.password,
        });
      } else {
        failedAccountCount++;
        logger.warn(
          {
            tenantId,
            orgId: org.orgId,
            member: member.emailLocalPart,
            created: account !== null,
          },
          "sandbox provisioning: member account creation or authorization failed — continuing",
        );
      }
      await updateJobProgress(jobId, {
        currentStep: `creating accounts (${index + 2}/${template.members.length + 1})`,
        completedSteps: 2 + index + 1,
      });
    }

    await registerTenantMembers(tenantId, members);

    await updateJobProgress(jobId, {
      currentStep: "seeding_modules",
      completedSteps: totalSteps - 2,
    });

    // T9/T10 -- install every core module's schema/workflow/automation-rule seed SQL,
    // then seed a small set of real records across each module's workflow states. A
    // module install or data-seed failure here is caught per-module inside each
    // function (continues with the rest), not surfaced as a job-level failure -- a
    // sandbox with some modules only partially seeded is still useful; a partially
    // created ORG/tenant/accounts is not, which is what T11's rollback guards against.
    const coreModuleInstall = await installCoreModulesForSandbox(tenantId);
    await seedAllModulesData(
      tenantId,
      coreModuleInstall.succeeded,
      members.map((m) => m.userId),
    );

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
    // Review finding (PR #804): this is also why no password is ever part of this
    // function's return value below -- BullMQ's removeOnComplete would otherwise persist
    // it a second time, in Redis's job-result store, with no gating at all. This dedicated
    // handover store (behind requirePlatformAdmin + MFA + the handover route's own status
    // check) is the only place it's retrievable from.
    //
    // Review finding (PR #805): wrapped in its own try/catch -- a transient Redis write
    // failure here must not fail the whole job. The Zitadel org, tenant row, and every
    // account already exist and are fully usable at this point; failing the job over this
    // last step alone would mark a genuinely-successful provisioning run as "failed" with
    // no automatic recovery path. The trade-off (accepted deliberately, not by omission):
    // if this does fail, the handover credentials are unrecoverable from Redis and must be
    // reset via the Zitadel console out-of-band -- same recovery path already documented
    // in the spec for an expired 7-day handover window.
    try {
      await storeSandboxHandoverCredentials(tenantId, {
        seededAccounts,
      });
    } catch (err) {
      logger.error(
        { err, tenantId, jobId },
        "sandbox provisioning: failed to store handover credentials -- job still completes, but credentials are unrecoverable until reset via the Zitadel console",
      );
    }

    await updateJobProgress(jobId, {
      status: "completed",
      currentStep: null,
      completedSteps: totalSteps,
      // Review finding (PR #805): previously never written, leaving this column always
      // NULL -- useful for manual recovery lookups (e.g. the Redis-handover-failure case
      // just above, or before T11's automatic rollback existed).
      zitadelOrgId: org.orgId,
    });

    await auditOutcome(job, tenantId, "sandbox.provisioning_completed", {
      zitadelOrgId: org.orgId,
      seededAccountCount,
      failedAccountCount,
    });
    // T16 (ADR-022 Decision 7): platform-admin-level record, alongside admin_audit_log's
    // tenant-scoped entry above -- see @platform/db's recordPlatformAdminAction doc comment.
    // Best-effort (PR #859 review [C]): admin_audit_log above is the authoritative record.
    // A throw here would reach the catch below and roll back a sandbox that was fully built.
    await recordPlatformAdminAction({
      actorSub: job.data.requestedBy,
      action: "sandbox.created",
      targetTenantId: tenantId,
    }).catch((err: unknown) => {
      logger.error(
        { err, tenantId, jobId },
        "sandbox provisioning: platform-admin audit record failed -- sandbox kept",
      );
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
      // The job row's result_tenant_id references this tenant (FK, no ON DELETE action), so
      // clear it first or the delete below fails and leaves an orphaned sandbox tenant.
      await db
        .update(sandboxProvisioningJobs)
        .set({ resultTenantId: null, updatedAt: new Date() })
        .where(eq(sandboxProvisioningJobs.id, jobId))
        .then(() =>
          withTenantLifecycleContext((tx) =>
            tx.delete(tenants).where(eq(tenants.id, tenantId)),
          ),
        )
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
