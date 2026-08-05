import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { saveUpload, FileError } from "@platform/files";
import { connection } from "../../lib/redis.js";
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

const MAX_FILE_BYTES = 100 * 1024 * 1024;

const UploadFieldsSchema = z.object({
  // Kebab-case only (matches @modules/kebab-case convention) — this segment
  // is embedded verbatim into the on-disk storage path by buildStorageKey,
  // so it must never contain path separators or ".." traversal sequences.
  moduleSlug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
  entityId: z.string().uuid().optional(),
});

export const initiateUploadHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const { tenantId, userId } = c.get("auth");

    const body = await c.req.parseBody();
    const filePart = body["file"];
    if (!(filePart instanceof File)) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "file field is required" },
        400,
      );
    }

    const rawEntityId = body["entityId"];
    const fields = UploadFieldsSchema.safeParse({
      moduleSlug: body["moduleSlug"],
      entityId:
        typeof rawEntityId === "string" && rawEntityId !== ""
          ? rawEntityId
          : undefined,
    });
    if (!fields.success) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Invalid upload fields",
          fields: fields.error.flatten().fieldErrors,
        },
        422,
      );
    }

    if (!ALLOWED_MIME_TYPES.has(filePart.type)) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "MIME type is not in the allowed list",
        },
        422,
      );
    }
    if (filePart.size < 1 || filePart.size > MAX_FILE_BYTES) {
      return c.json(
        { error: "FILE_TOO_LARGE", message: "File size out of allowed range" },
        422,
      );
    }
    if (filePart.name.length < 1 || filePart.name.length > 255) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Invalid file name" },
        422,
      );
    }

    const bytes = Buffer.from(await filePart.arrayBuffer());

    try {
      const result = await withTenantContext(tenantId, (tx) =>
        saveUpload(
          tx,
          connection,
          tenantId,
          userId,
          fields.data.moduleSlug,
          fields.data.entityId ?? null,
          filePart.name,
          filePart.type,
          bytes,
        ),
      );
      return c.json({ data: result }, 201);
    } catch (err: unknown) {
      if (err instanceof FileError) {
        switch (err.code) {
          case "FILE_TOO_LARGE":
            return c.json(
              { error: err.code, message: "File exceeds the allowed size" },
              422,
            );
          case "QUOTA_EXCEEDED":
            return c.json(
              { error: err.code, message: "Storage quota exceeded" },
              422,
            );
        }
      }
      throw err;
    }
  },
);
