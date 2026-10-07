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
 *     way export-worker.ts audits export.completed/export.failed — not once per step; R5's
 *     wait-screen progress is read from structured logs until T8 builds a persisted
 *     step-counter. The tenant id is generated upfront (not left to the INSERT's
 *     defaultRandom()) specifically so a failure in org creation or the tenant insert
 *     itself still has a stable id to audit under (security review finding — previously
 *     those two steps weren't audited on failure at all).
 *
 * Deliberately NOT yet built here: T8 (persisted job progress for the polling endpoint),
 * T21 (handover endpoint — the default password is returned in the job's return value as an
 * interim so it isn't lost, but there's no dedicated retrieval route yet), T9/T10 (module
 * data/automation seeding), T11 (retry-vs-rollback on partial failure — a failed job here
 * leaves whatever Zitadel org/accounts were already created in place; nothing cleans them up).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { Worker } from "@platform/telemetry";
import { db, tenants } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import {
  createOrg,
  createHumanUser,
  generateSandboxOrgTemplate,
  nextEmailCandidate,
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
  defaultPassword: string;
  seededAccountCount: number;
  failedAccountCount: number;
}

type SandboxProvisioningJob = {
  id?: string | undefined;
  data: SandboxProvisioningJobPayload;
};

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

  logger.info({ orgName, jobId: job.id }, "sandbox provisioning job started");

  // Generated upfront (not left to the INSERT's defaultRandom()) so a stable id exists
  // to audit under even if org creation or the tenant insert itself is what fails --
  // security review finding: the audit-failure path previously only wrapped the code
  // AFTER the tenant row existed, so an org-creation or tenant-insert failure (e.g. a
  // transient Zitadel 5xx, or a slug collision) left behind a live Zitadel org with zero
  // audit trace at all. admin_audit_log.tenant_id has no FK constraint, so auditing under
  // this id is safe even on the path where the tenant row never ends up existing.
  const tenantId = randomUUID();
  let zitadelOrgId: string | undefined;

  try {
    const org = await createOrgWithRetry(orgName);
    if (!org) {
      throw new Error("SANDBOX_ORG_CREATE_FAILED");
    }
    zitadelOrgId = org.orgId;

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

    const template = generateSandboxOrgTemplate();
    const domain = sandboxEmailDomain();
    const defaultPassword = generateSandboxPassword();

    const admin = await createAccountWithRetry(
      org.orgId,
      template.admin,
      defaultPassword,
      domain,
    );
    if (!admin) {
      throw new Error("SANDBOX_ADMIN_ACCOUNT_CREATE_FAILED");
    }

    let seededAccountCount = 1;
    let failedAccountCount = 0;
    for (const member of template.members) {
      const account = await createAccountWithRetry(
        org.orgId,
        member,
        defaultPassword,
        domain,
      );
      if (account) {
        seededAccountCount++;
      } else {
        failedAccountCount++;
        logger.warn(
          { tenantId, orgId: org.orgId, member: member.emailLocalPart },
          "sandbox provisioning: member account creation failed after retries — continuing",
        );
      }
    }

    const syncResult = await runOrgDirectorySync(
      tenantId,
      new ZitadelOrgSourceImporter(),
      requestedBy,
    );

    logger.info(
      {
        tenantId,
        orgId: org.orgId,
        jobId: job.id,
        seededAccountCount,
        failedAccountCount,
        syncStatus: syncResult.status,
      },
      "sandbox provisioning job completed",
    );

    await auditOutcome(job, tenantId, "sandbox.provisioning_completed", {
      zitadelOrgId: org.orgId,
      seededAccountCount,
      failedAccountCount,
    });

    return {
      tenantId,
      zitadelOrgId: org.orgId,
      adminEmail: admin.email,
      defaultPassword,
      seededAccountCount,
      failedAccountCount,
    };
  } catch (err) {
    await auditOutcome(job, tenantId, "sandbox.provisioning_failed", {
      zitadelOrgId: zitadelOrgId ?? null,
      error: err instanceof Error ? err.message : "UNKNOWN",
    }).catch((auditErr: unknown) => {
      logger.error(
        { err: auditErr, tenantId, jobId: job.id },
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
