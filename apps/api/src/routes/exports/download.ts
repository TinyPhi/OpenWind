import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { exportQueue, PII_EXPORT_ROLES } from "../../lib/export-queue.js";
import type { AuthContext } from "@platform/auth";

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

    // If the export included PII columns, require either the original requester
    // or a PII-capable role. This covers: role revoked after enqueue, and
    // within-tenant job ID enumeration by a lower-privilege user.
    const jobIncludedPii =
      job.data.includePii ??
      job.data.requestedByRoles?.some((r) => PII_EXPORT_ROLES.has(r)) ??
      false;

    if (jobIncludedPii) {
      const canSeePii = roles.some((r) => PII_EXPORT_ROLES.has(r));
      if (!canSeePii && job.data.requestedBy !== userId) {
        return c.json(
          { error: "NOT_FOUND", message: "Export job not found" },
          404,
        );
      }
    }

    const state = await job.getState();

    if (state === "completed") {
      const result = job.returnvalue as {
        downloadUrl?: string;
        error?: string;
      } | null;
      // returnvalue is null when removeOnComplete TTL has expired
      if (!result?.downloadUrl) {
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
      return c.json({
        data: { status: "complete", downloadUrl: result.downloadUrl },
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
