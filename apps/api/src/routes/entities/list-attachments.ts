import { requireAuth } from "@platform/auth";
import { entityInstances, files, withTenantContext } from "@platform/db";
import { and, eq, inArray } from "drizzle-orm";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

export const listAttachmentsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");

    try {
      const [instance, allowed] = await withTenantContext(
        tenantId,
        async (tx) => {
          const [row] = await tx
            .select({
              id: entityInstances.id,
              createdBy: entityInstances.createdBy,
              assignedTo: entityInstances.assignedTo,
              fields: entityInstances.fields,
              workflowId: entityInstances.workflowId,
            })
            .from(entityInstances)
            .where(
              and(
                eq(entityInstances.id, id),
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
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      const rows = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            id: files.id,
            originalName: files.originalName,
            mimeType: files.mimeType,
            sizeBytes: files.sizeBytes,
            scanStatus: files.scanStatus,
            uploadedBy: files.uploadedBy,
            createdAt: files.createdAt,
          })
          .from(files)
          .where(
            and(
              eq(files.tenantId, tenantId),
              eq(files.entityId, id),
              // M-5: infected files must never appear in the list (only
              // clean and still-scanning files) — previously only "deleted"
              // was excluded, so infected files were listed and downloadable.
              inArray(files.scanStatus, ["clean", "pending"]),
            ),
          )
          .orderBy(files.createdAt),
      );

      return c.json({ data: rows });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
