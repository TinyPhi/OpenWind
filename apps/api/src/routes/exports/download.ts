import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import type { AuditAction } from "@platform/audit";
import {
  exportQueue,
  isUserDataExportPayload,
  PII_EXPORT_ROLES,
} from "../../lib/export-queue.js";
import type { AuthContext } from "@platform/auth";
import { Readable } from "node:stream";
import { getExportStream } from "@platform/files";

const JobIdParamSchema = z.object({
  jobId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9:_-]+$/, "Invalid job ID"),
});

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.get(
  "/:jobId/download",
  requireAuth(),
  requireRole("agent", "admin"),
  zValidator("param", JobIdParamSchema),
  async (c) => {
    const { tenantId, userId, roles } = c.get("auth");
    const { jobId } = c.req.valid("param");

    const job = await exportQueue.getJob(jobId);

    if (!job) {
      return c.json(
        { error: "NOT_FOUND", message: "Export job not found" },
        404,
      );
    }

    // Prevent cross-tenant access — job payload contains the originating tenant
    if (job.data.tenantId !== tenantId) {
      return c.json(
        { error: "NOT_FOUND", message: "Export job not found" },
        404,
      );
    }

    // A data-subject export holds one person's personal data and is served only
    // by the admin-only route in platform/user-export.ts; never through here,
    // which agents can reach. Same 404 as a missing job.
    if (isUserDataExportPayload(job.data)) {
      await withTenantContext(tenantId, (tx) =>
        writeAuditEntry(tx, {
          tenantId,
          actorId: userId,
          actorType: "user",
          resourceType: "user_data_export",
          // resource_id is a uuid column; the job id is "userdata-<uuid>".
          resourceId: jobId.slice("userdata-".length),
          action: "export.download_denied",
          metadata: { jobId, via: "entity_export_route" },
        }),
      );
      return c.json(
        { error: "NOT_FOUND", message: "Export job not found" },
        404,
      );
    }

    const jobData = job.data;

    // If the export included PII columns, require either the original requester
    // or a PII-capable role. This covers: role revoked after enqueue, and
    // within-tenant job ID enumeration by a lower-privilege user.
    // #693: written under the caller's tenant, which the check above has
    // already confirmed is the job's. Fail-closed: if the write fails, the
    // handler throws and no URL leaves.
    const audit = (action: AuditAction): Promise<void> =>
      withTenantContext(tenantId, (tx) =>
        writeAuditEntry(tx, {
          tenantId,
          actorId: userId,
          actorType: "user",
          resourceType: "entity_type",
          resourceId: jobData.entityTypeId,
          action,
          metadata: { jobId, format: jobData.format, mode: "async" },
        }),
      );

    const jobIncludedPii =
      jobData.includePii ??
      jobData.requestedByRoles?.some((r) => PII_EXPORT_ROLES.has(r)) ??
      false;

    if (jobIncludedPii) {
      const canSeePii = roles.some((r) => PII_EXPORT_ROLES.has(r));
      if (!canSeePii && jobData.requestedBy !== userId) {
        await audit("export.download_denied");
        return c.json(
          { error: "NOT_FOUND", message: "Export job not found" },
          404,
        );
      }
    }

    const state = await job.getState();

    if (state === "completed") {
      const result = job.returnvalue as {
        storageKey?: string;
        format?: "csv" | "xlsx" | "pdf";
        error?: string;
      } | null;
      // returnvalue is null when removeOnComplete TTL has expired
      if (!result?.storageKey || !result.format) {
        return c.json(
          {
            data: {
              status: "failed",
              error: result?.error ?? "EXPORT_EXPIRED",
            },
          },
          200,
        );
      }

      if (c.req.query("file") === "1") {
        const file = await getExportStream(
          tenantId,
          jobId,
          result.format,
          result.storageKey,
        );
        // Fail closed: record the actual download before any bytes leave.
        await audit("export.downloaded");
        c.header("Content-Type", file.mimeType);
        c.header("Content-Length", String(file.sizeBytes));
        c.header(
          "Content-Disposition",
          `attachment; filename="${file.originalName}"`,
        );
        return c.body(Readable.toWeb(file.stream) as ReadableStream);
      }

      return c.json({
        data: {
          status: "complete",
          downloadUrl: `/exports/${jobId}/download?file=1`,
        },
      });
    }

    if (state === "failed") {
      // Return 200 so the client's polling branch lands on status: "failed"
      // rather than treating the response as a network error.
      return c.json(
        { data: { status: "failed", error: "EXPORT_FAILED" } },
        200,
      );
    }

    return c.json({ data: { status: "pending" } }, 202);
  },
);

export { router as exportsRouter };
