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
        })
        .from(files)
        .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
        .limit(1),
    );

    if (!file || file.scanStatus === "deleted") {
      return c.json({ error: "NOT_FOUND", message: "File not found" }, 404);
    }

    // Same entity ACL check download.ts applies — otherwise a user without
    // record access could learn a file's existence/scan status by hitting
    // this endpoint directly instead of going through the entity.
    if (file.entityId) {
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
    }

    return c.json({ data: { fileId: file.id, scanStatus: file.scanStatus } });
  },
);
