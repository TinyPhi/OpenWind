import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import { db, tenantUsers, withTenantContext } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import type { AuditAction } from "@platform/audit";
import { env } from "@platform/config";
import {
  FileError,
  USER_DATA_EXPORT_JOB_PREFIX,
  getExportStream,
} from "@platform/files";
import { zValidator } from "../../lib/validator.js";
import {
  exportQueue,
  isUserDataExportPayload,
} from "../../lib/export-queue.js";
import { enforceExportRateLimit } from "../../lib/rate-limit-tiers.js";

type AppVars = { Variables: { auth: AuthContext } };

// Zitadel ids are numeric today; the pattern also admits the UUID and
// email-shaped ids other IdPs use, and bounds what is stored in audit metadata.
const UserIdParamSchema = z.object({
  userId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._@-]+$/, "Invalid user ID"),
});

const DownloadParamSchema = UserIdParamSchema.extend({
  jobId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9:_-]+$/, "Invalid job ID"),
});

export const AUDIT_RESOURCE_TYPE = "user_data_export";

/** admin_audit_log.resource_id is a uuid: the export's uuid, not the job id. */
function exportIdOf(jobId: string): string | null {
  const id = jobId.startsWith(USER_DATA_EXPORT_JOB_PREFIX)
    ? jobId.slice(USER_DATA_EXPORT_JOB_PREFIX.length)
    : "";
  return z.string().uuid().safeParse(id).success ? id : null;
}

export const userExportRouter = new Hono<AppVars>();

// POST /users/:userId/export — GDPR Art. 15/20 data-subject export, admin-only.
userExportRouter.post(
  "/:userId/export",
  requireAuth(db),
  requireRole("admin"),
  zValidator("param", UserIdParamSchema),
  async (c) => {
    const { tenantId, userId: adminUserId } = c.get("auth");
    const { userId: subjectUserId } = c.req.valid("param");

    const { allowed, resetAt } = await enforceExportRateLimit(
      tenantId,
      adminUserId,
    );
    if (!allowed) {
      c.header(
        "Retry-After",
        String(Math.max(1, resetAt - Math.ceil(Date.now() / 1000))),
      );
      return c.json(
        { error: "RATE_LIMITED", message: "Too many export requests" },
        429,
      );
    }

    // 404 for a user with no row in THIS tenant, whatever tenant they belong to.
    const [member] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({ id: tenantUsers.id })
        .from(tenantUsers)
        .where(
          and(
            eq(tenantUsers.tenantId, tenantId),
            eq(tenantUsers.userId, subjectUserId),
          ),
        )
        .limit(1),
    );
    if (!member) {
      return c.json({ error: "NOT_FOUND", message: "User not found" }, 404);
    }

    const exportId = randomUUID();
    const jobId = `${USER_DATA_EXPORT_JOB_PREFIX}${exportId}`;
    // Metadata holds ids and settings, never bundle contents.
    const audit = (
      action: AuditAction,
      metadata: Record<string, unknown>,
    ): Promise<void> =>
      withTenantContext(tenantId, (tx) =>
        writeAuditEntry(tx, {
          tenantId,
          actorId: adminUserId,
          actorType: "user",
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: exportId,
          action,
          metadata: { jobId, subjectUserId, format: "json", ...metadata },
        }),
      );

    await audit("export.requested", { mode: "async" });
    let job;
    try {
      job = await exportQueue.add(
        "export",
        {
          kind: "user_data",
          tenantId,
          subjectUserId,
          requestedBy: adminUserId,
        },
        {
          jobId,
          // The job record is what the download route authorises against, so
          // it must live as long as the file does.
          removeOnComplete: { age: env.USER_EXPORT_TTL_DAYS * 86_400 },
          removeOnFail: { age: 86_400 },
        },
      );
    } catch (err) {
      await audit("export.failed", { error: "ENQUEUE_FAILED" });
      throw err;
    }
    if (!job.id) throw new Error("Export job enqueue returned no ID");
    return c.json({ data: { jobId: job.id } }, 202);
  },
);

// GET /users/:userId/export/:jobId/download — separate from /exports/:jobId/download,
// which agents can reach. Admin-only, and the job must be this tenant's user_data
// export of this user.
userExportRouter.get(
  "/:userId/export/:jobId/download",
  requireAuth(db),
  requireRole("admin"),
  zValidator("param", DownloadParamSchema),
  async (c) => {
    const { tenantId, userId: adminUserId } = c.get("auth");
    const { userId: subjectUserId, jobId } = c.req.valid("param");
    const notFound = (): Response =>
      c.json({ error: "NOT_FOUND", message: "Export job not found" }, 404);

    const job = await exportQueue.getJob(jobId);
    if (
      !job ||
      !isUserDataExportPayload(job.data) ||
      job.data.tenantId !== tenantId
    ) {
      return notFound();
    }

    const exportId = exportIdOf(jobId);
    if (!exportId) return notFound();
    const audit = (action: AuditAction): Promise<void> =>
      withTenantContext(tenantId, (tx) =>
        writeAuditEntry(tx, {
          tenantId,
          actorId: adminUserId,
          actorType: "user",
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: exportId,
          action,
          metadata: { jobId, subjectUserId, format: "json" },
        }),
      );

    if (job.data.subjectUserId !== subjectUserId) {
      await audit("export.download_denied");
      return notFound();
    }

    const state = await job.getState();
    if (state === "failed") {
      return c.json(
        { data: { status: "failed", error: "EXPORT_FAILED" } },
        200,
      );
    }
    if (state !== "completed") {
      return c.json({ data: { status: "pending" } }, 202);
    }

    const result = job.returnvalue as {
      storageKey?: string;
      error?: string;
    } | null;
    const expired =
      job.finishedOn !== undefined &&
      Date.now() - job.finishedOn > env.USER_EXPORT_TTL_DAYS * 86_400_000;
    if (!result?.storageKey || expired) {
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

    if (c.req.query("file") !== "1") {
      return c.json({
        data: {
          status: "complete",
          downloadUrl: `/users/${subjectUserId}/export/${jobId}/download?file=1`,
        },
      });
    }

    let file;
    try {
      file = await getExportStream(tenantId, jobId, "json", result.storageKey);
    } catch (err) {
      // The daily sweep deleted the file before the job record aged out.
      if (err instanceof FileError && err.code === "STORAGE_READ_FAILED") {
        return c.json(
          { data: { status: "failed", error: "EXPORT_EXPIRED" } },
          200,
        );
      }
      throw err;
    }
    // Fail closed: record the download before any bytes leave.
    await audit("export.downloaded");
    c.header("Content-Type", file.mimeType);
    c.header("Content-Length", String(file.sizeBytes));
    c.header(
      "Content-Disposition",
      `attachment; filename="${file.originalName}"`,
    );
    c.header("Cache-Control", "no-store");
    return c.body(Readable.toWeb(file.stream) as ReadableStream);
  },
);
