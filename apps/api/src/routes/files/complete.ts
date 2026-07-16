import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { connection } from "../../lib/redis.js";
import { confirmUpload, FileError } from "@platform/files";
import { factory } from "./factory.js";

const FileIdParamSchema = z.object({ id: z.string().uuid() });

export const confirmUploadHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("param", FileIdParamSchema),
  async (c) => {
    const { id: fileId } = c.req.valid("param");
    const { tenantId } = c.get("auth");

    try {
      await confirmUpload(db, connection, tenantId, fileId);
      return c.json({ data: { fileId, status: "pending" } });
    } catch (err: unknown) {
      if (err instanceof FileError) {
        if (err.code === "FILE_NOT_FOUND") {
          return c.json({ error: err.code, message: "File not found" }, 404);
        }
      }
      throw err;
    }
  },
);
