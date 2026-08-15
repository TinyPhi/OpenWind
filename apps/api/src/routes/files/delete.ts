import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { zValidator } from "../../lib/validator.js";
import { requireAuth, requireRole } from "@platform/auth";
import { files, withTenantContext } from "@platform/db";
import { deleteFile, FileError } from "@platform/files";
import { factory } from "./factory.js";
import { emitFileDeleted } from "../../lib/emit-access-event.js";

const FileIdParamSchema = z.object({ id: z.string().uuid() });

export const deleteFileHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("param", FileIdParamSchema),
  async (c) => {
    const { id: fileId } = c.req.valid("param");
    const { tenantId, userId } = c.get("auth");

    try {
      const [file] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            entityId: files.entityId,
            originalName: files.originalName,
          })
          .from(files)
          .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
          .limit(1),
      );

      await withTenantContext(tenantId, (tx) =>
        deleteFile(tx, tenantId, fileId),
      );

      if (file?.entityId) {
        void emitFileDeleted(
          tenantId,
          file.entityId,
          userId,
          fileId,
          file.originalName,
        );
      }

      return c.body(null, 204);
    } catch (err: unknown) {
      if (err instanceof FileError && err.code === "FILE_NOT_FOUND") {
        return c.json({ error: err.code, message: "File not found" }, 404);
      }
      throw err;
    }
  },
);
