import { z } from "zod";
import { Readable } from "node:stream";
import { zValidator } from "../../lib/validator.js";
import { requireAuth, requireRole } from "@platform/auth";
import { files, entityInstances, withTenantContext } from "@platform/db";
import { and, eq } from "drizzle-orm";
import { getFileStream, FileError } from "@platform/files";
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
          .select({ entityId: files.entityId, uploadedBy: files.uploadedBy })
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
      } else if (file) {
        // Unbound file: only the uploader or privileged roles may access it.
        // Without this check any tenant member who knows the fileId can obtain
        // a presigned URL for another user's unattached file. (#224 / #239)
        const isPrivileged = roles.includes("admin") || roles.includes("agent");
        if (!isPrivileged && file.uploadedBy !== userId) {
          return c.json(
            { error: "FILE_NOT_FOUND", message: "File not found" },
            404,
          );
        }
      }

      const result = await withTenantContext(tenantId, (tx) =>
        getFileStream(tx, tenantId, fileId),
      );

      // Strip characters that can break or inject the Content-Disposition header:
      // \r\n ends the header line and lets an attacker inject arbitrary headers;
      // " closes the quoted filename value early; bidirectional-override Unicode
      // chars (U+200E/F, U+202A–E) can reverse the displayed filename in browsers
      // to make "malware.exe" appear as "malware.pdf". (#241)
      const safeFilename = result.originalName
        .replace(/[\r\n"]/g, "_")
        .replace(/[‎‏‪-‮]/g, "");

      // SVG files are active documents — browsers execute their JavaScript in the
      // page origin. Force attachment even when the caller requests inline display
      // to prevent a stored-XSS attack via a crafted SVG upload. (#240)
      const isSvg =
        result.mimeType === "image/svg+xml" || result.mimeType.includes("svg");
      const dispositionType = inline && !isSvg ? "inline" : "attachment";

      c.header("Content-Type", result.mimeType);
      c.header("Content-Length", String(result.sizeBytes));
      c.header(
        "Content-Disposition",
        `${dispositionType}; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(result.originalName)}`,
      );
      return c.body(Readable.toWeb(result.stream) as ReadableStream);
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
