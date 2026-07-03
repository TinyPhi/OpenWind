import { requireAuth } from "@platform/auth";
import { entityInstances, files, withTenantContext } from "@platform/db";
import { and, eq, ne } from "drizzle-orm";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

export const listAttachmentsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");

    try {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ id: entityInstances.id })
          .from(entityInstances)
          .where(
            and(
              eq(entityInstances.id, id),
              eq(entityInstances.tenantId, tenantId),
            ),
          )
          .limit(1),
      );

      if (!instance) {
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
              ne(files.scanStatus, "deleted"),
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
