import { requireAuth } from "@platform/auth";
import {
  entityInstances,
  workflowEvents,
  withTenantContext,
  db,
} from "@platform/db";
import { and, eq, sql } from "drizzle-orm";
import { deleteFile } from "@platform/files";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

export const deleteCommentAttachmentHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const eventId = c.req.param("eventId") ?? "";
    const fileId = c.req.param("fileId") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const isPrivileged = roles.includes("admin") || roles.includes("agent");

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

      const [event] = await withTenantContext(tenantId, (tx) =>
        tx
          .select()
          .from(workflowEvents)
          .where(
            and(
              eq(workflowEvents.id, eventId),
              eq(workflowEvents.instanceId, id),
              eq(workflowEvents.tenantId, tenantId),
            ),
          )
          .limit(1),
      );

      if (!event) {
        return c.json(
          { error: "NOT_FOUND", message: "Comment not found" },
          404,
        );
      }

      const metadata = event.metadata as Record<string, unknown>;
      if (metadata.type !== "comment") {
        return c.json(
          { error: "NOT_FOUND", message: "Comment not found" },
          404,
        );
      }

      // Only the comment author or admin/agent can remove attachments
      if (!isPrivileged && event.actorId !== userId) {
        return c.json(
          { error: "NOT_FOUND", message: "Comment not found" },
          404,
        );
      }

      const existingFileIds: string[] = Array.isArray(metadata.fileIds)
        ? (metadata.fileIds as string[])
        : [];

      if (!existingFileIds.includes(fileId)) {
        return c.json({ error: "NOT_FOUND", message: "File not found" }, 404);
      }

      // Remove fileId from the metadata.fileIds array
      await withTenantContext(tenantId, (tx) =>
        tx
          .update(workflowEvents)
          .set({
            metadata: sql`jsonb_set(
              metadata,
              '{fileIds}',
              (
                SELECT jsonb_agg(elem)
                FROM jsonb_array_elements_text(COALESCE(metadata->'fileIds', '[]'::jsonb)) AS elem
                WHERE elem != ${fileId}::text
              )
            )`,
          })
          .where(
            and(
              eq(workflowEvents.id, eventId),
              eq(workflowEvents.tenantId, tenantId),
            ),
          ),
      );

      // Soft-delete the file itself
      await deleteFile(db, tenantId, fileId);

      return c.body(null, 204);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
