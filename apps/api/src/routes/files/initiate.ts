import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { initiateUpload } from "@platform/files";
import { factory } from "./factory.js";

/**
 * Allowlist of MIME types accepted for upload.
 *
 * Restricts upload to well-known safe formats.  Add types here only after
 * confirming ClamAV can scan them and the frontend can preview/handle them.
 * Executable types (application/x-executable, application/x-msdownload, etc.)
 * are intentionally excluded.
 */
const ALLOWED_MIME_TYPES = new Set([
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Plain text / data
  "text/plain",
  "text/csv",
  "application/json",
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Archives (scanned by ClamAV)
  "application/zip",
  "application/x-zip-compressed",
]);

const InitiateUploadSchema = z.object({
  originalName: z.string().min(1).max(255),
  mimeType: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => ALLOWED_MIME_TYPES.has(v), {
      message: "MIME type is not in the allowed list",
    }),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(100 * 1024 * 1024),
  moduleSlug: z.string().min(1).max(100),
  entityId: z.string().uuid().optional(),
});

export const initiateUploadHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", InitiateUploadSchema),
  async (c) => {
    const input = c.req.valid("json");
    const { tenantId, userId } = c.get("auth");

    const result = await initiateUpload(
      db,
      tenantId,
      userId,
      input.moduleSlug,
      input.entityId ?? null,
      input.originalName,
      input.mimeType,
      input.sizeBytes,
    );

    return c.json({ data: result }, 201);
  },
);
