import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, requireRole } from "@platform/auth";
import { files, entityInstances, withTenantContext } from "@platform/db";
import { and, eq } from "drizzle-orm";
import { getDownloadUrl, FileError } from "@platform/files";
import { factory } from "./factory.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

const FileIdParamSchema = z.object({ id: z.string().uuid() });

export const getDownloadUrlHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("param", FileIdParamSchema),
  async (c) => {
    const { id: fileId } = c.req.valid("param");
    const { tenantId, userId, roles } = c.get("auth");
    const inline = c.req.query("inline") === "1";

    try {
      // Files bound to an entity inherit that record's __accessUsers ACL —
      // otherwise a user without record access could bypass it by hitting
      // the download endpoint directly instead of going through the entity.
      const [file] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ entityId: files.entityId })
          .from(files)
          .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
          .limit(1),
      );

      if (file?.entityId) {
        const [instance, allowed] = await withTenantContext(
          tenantId,
          async (tx) => {
            const [row] = await tx
              .select({
                createdBy: entityInstances.createdBy,
                assignedTo: entityInstances.assignedTo,
                fields: entityInstances.fields,
                workflowId: entityInstances.workflowId,
              })
              .from(entityInstances)
              .where(
                and(
                  eq(entityInstances.id, file.entityId as string),
                  eq(entityInstances.tenantId, tenantId),
                ),
              )
              .limit(1);
            if (!row) return [undefined, false] as const;
            return [
              row,
              await hasEntityAccess(tx, tenantId, row, userId, roles),
            ] as const;
          },
        );

        if (!instance || !allowed) {
          return c.json(
            { error: "FILE_NOT_FOUND", message: "File not found" },
            404,
          );
        }
      }

      const result = await withTenantContext(tenantId, (tx) =>
        getDownloadUrl(tx, tenantId, fileId, inline),
      );
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
