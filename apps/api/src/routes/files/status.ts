import { requireAuth } from "@platform/auth";
import { files, entityInstances, withTenantContext } from "@platform/db";
import { and, eq } from "drizzle-orm";
import { factory } from "./factory.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

export const getFileScanStatusHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const fileId = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");

    const [file] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          id: files.id,
          scanStatus: files.scanStatus,
          entityId: files.entityId,
          uploadedBy: files.uploadedBy,
        })
        .from(files)
        .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
        .limit(1),
    );

    if (!file || file.scanStatus === "deleted") {
      return c.json({ error: "NOT_FOUND", message: "File not found" }, 404);
    }

    if (file.entityId) {
      // Same entity ACL check download.ts applies — otherwise a user without
      // record access could learn a file's existence/scan status by hitting
      // this endpoint directly instead of going through the entity.
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
        return c.json({ error: "NOT_FOUND", message: "File not found" }, 404);
      }
    } else {
      // Unbound file: only the uploader or privileged roles may check its
      // status. Without this check any tenant member who knows the fileId
      // can learn whether it exists and whether it passed AV scanning. (#224)
      const isPrivileged = roles.includes("admin") || roles.includes("agent");
      if (!isPrivileged && file.uploadedBy !== userId) {
        return c.json({ error: "NOT_FOUND", message: "File not found" }, 404);
      }
    }

    return c.json({ data: { fileId: file.id, scanStatus: file.scanStatus } });
  },
);
