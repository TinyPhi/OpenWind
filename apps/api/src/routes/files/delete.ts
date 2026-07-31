import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { deleteFile, FileError } from "@platform/files";
import { factory } from "./factory.js";

const FileIdParamSchema = z.object({ id: z.string().uuid() });

export const deleteFileHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("param", FileIdParamSchema),
  async (c) => {
    const { id: fileId } = c.req.valid("param");
    const { tenantId } = c.get("auth");

    try {
      await withTenantContext(tenantId, (tx) =>
        deleteFile(tx, tenantId, fileId),
      );
      return c.body(null, 204);
    } catch (err: unknown) {
      if (err instanceof FileError && err.code === "FILE_NOT_FOUND") {
        return c.json({ error: err.code, message: "File not found" }, 404);
      }
      throw err;
    }
  },
);
