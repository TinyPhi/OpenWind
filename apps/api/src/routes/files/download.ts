import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { getDownloadUrl, FileError } from "@platform/files";
import { factory } from "./factory.js";

const FileIdParamSchema = z.object({ id: z.string().uuid() });

export const getDownloadUrlHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("param", FileIdParamSchema),
  async (c) => {
    const { id: fileId } = c.req.valid("param");
    const { tenantId } = c.get("auth");
    const inline = c.req.query("inline") === "1";

    try {
      const result = await getDownloadUrl(db, tenantId, fileId, inline);
      return c.json({ data: result });
    } catch (err: unknown) {
      if (err instanceof FileError) {
        switch (err.code) {
          case "FILE_NOT_FOUND":
            return c.json({ error: err.code, message: "File not found" }, 404);
          case "FILE_PENDING_SCAN":
            return c.json(
              {
                error: err.code,
                message:
                  "File is pending antivirus scan — try again in a moment",
              },
              422,
            );
          case "FILE_QUARANTINED":
            return c.json(
              { error: err.code, message: "File failed antivirus scan" },
              422,
            );
        }
      }
      throw err;
    }
  },
);
