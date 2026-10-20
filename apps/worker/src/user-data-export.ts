/**
 * user-data-export.ts
 *
 * Processor for `user_data` jobs on the "export" queue (GDPR Art. 15/20,
 * docs/specs/user-data-export.md). Collects the subject's data in one tenant
 * transaction, saves it as JSON under the tenant's export tree, and audits the
 * outcome. The API route already wrote export.requested. The bundle contents
 * are never logged or audited.
 */

import { withTenantContext } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import type { AuditAction } from "@platform/audit";
import { env } from "@platform/config";
import {
  collectUserDataBundle,
  serializeUserDataBundle,
  type UserDataExportJobPayload,
  type UserDataExportJobResult,
} from "@platform/entity-engine";
import { saveExport, USER_DATA_EXPORT_JOB_PREFIX } from "@platform/files";
import { logger } from "@platform/logger";
import { validateActiveTenant } from "./tenant-guard.js";

type UserDataJob = { id?: string | undefined; data: UserDataExportJobPayload };

async function auditUserExport(
  job: UserDataJob,
  action: AuditAction,
  metadata: Record<string, unknown>,
): Promise<void> {
  const { tenantId, subjectUserId, requestedBy } = job.data;
  const jobId = job.id ?? "";
  // resource_id is a uuid column; the job id is "userdata-<uuid>".
  const exportId = jobId.slice(USER_DATA_EXPORT_JOB_PREFIX.length);
  await withTenantContext(tenantId, (tx) =>
    writeAuditEntry(tx, {
      tenantId,
      actorId: requestedBy,
      actorType: "user",
      resourceType: "user_data_export",
      resourceId: exportId,
      action,
      metadata: {
        jobId,
        subjectUserId,
        format: "json",
        mode: "async",
        ...metadata,
      },
    }),
  );
}

export async function processUserDataExportJob(
  job: UserDataJob,
): Promise<UserDataExportJobResult> {
  try {
    const result = await runUserDataExportJob(job);
    if (result.error) {
      await auditUserExport(job, "export.failed", { error: result.error });
    } else {
      await auditUserExport(job, "export.completed", {
        rowCount: result.rowCount,
      });
    }
    return result;
  } catch (err) {
    await auditUserExport(job, "export.failed", { error: "JOB_FAILED" }).catch(
      (auditErr: unknown) => {
        logger.error(
          { err: auditErr, tenantId: job.data.tenantId, jobId: job.id },
          "user data export: failed to audit export failure",
        );
      },
    );
    throw err;
  }
}

async function runUserDataExportJob(
  job: UserDataJob,
): Promise<UserDataExportJobResult> {
  const { tenantId, subjectUserId } = job.data;
  if (!job.id?.startsWith(USER_DATA_EXPORT_JOB_PREFIX)) {
    throw new Error("User data export job has a missing or foreign id");
  }
  logger.info({ tenantId, jobId: job.id }, "user data export job started");

  const active = await validateActiveTenant(tenantId, "user data export job", {
    jobId: job.id,
  });
  if (!active) {
    return { error: "TENANT_DEACTIVATED", format: "json", rowCount: 0 };
  }

  const bundle = await withTenantContext(tenantId, (tx) =>
    collectUserDataBundle(tx, {
      tenantId,
      userId: subjectUserId,
      rowLimit: env.USER_EXPORT_ROW_LIMIT,
      includeAudit: env.USER_EXPORT_INCLUDE_AUDIT,
      ttlDays: env.USER_EXPORT_TTL_DAYS,
    }),
  );
  const rowCount = Object.values(bundle.data).reduce(
    (n, rows) => n + rows.length,
    0,
  );

  const storageKey = await saveExport(
    tenantId,
    job.id,
    "json",
    serializeUserDataBundle(bundle),
  );
  logger.info(
    { tenantId, jobId: job.id, rowCount, truncated: bundle.metadata.truncated },
    "user data export job completed",
  );
  return { storageKey, format: "json", rowCount };
}
