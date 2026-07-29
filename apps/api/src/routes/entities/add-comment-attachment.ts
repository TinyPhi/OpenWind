import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth } from "@platform/auth";
import {
  entityInstances,
  files,
  workflowEvents,
  withTenantContext,
} from "@platform/db";
import { and, eq, sql } from "drizzle-orm";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const AddCommentAttachmentSchema = z.object({
  fileId: z.string().uuid(),
});

export const addCommentAttachmentHandler = factory.createHandlers(
  requireAuth(),
  zValidator("json", AddCommentAttachmentSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const eventId = c.req.param("eventId") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const { fileId } = c.req.valid("json");
    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    try {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            id: entityInstances.id,
            workflowId: entityInstances.workflowId,
          })
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

      // Only the comment author, admin/agent, or an admin of this ticket's
      // workflow can attach files
      if (!isPrivileged && event.actorId !== userId) {
        const canAttach = instance.workflowId
          ? isWorkflowAdmin(
              userId,
              await withTenantContext(tenantId, (tx) =>
                getWorkflow(tx, tenantId, instance.workflowId as string, {
                  userId,
                  isGlobalAdmin: false,
                }),
              ),
            )
          : false;
        if (!canAttach) {
          return c.json(
            { error: "NOT_FOUND", message: "Comment not found" },
            404,
          );
        }
      }

      const [file] = await withTenantContext(tenantId, (tx) =>
        tx
          .select()
          .from(files)
          .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
          .limit(1),
      );

      if (!file || file.scanStatus === "deleted") {
        return c.json({ error: "NOT_FOUND", message: "File not found" }, 404);
      }

      if (file.scanStatus !== "clean") {
        // L-1: don't leak AV pipeline scanStatus enum values to the caller
        return c.json(
          { error: "FILE_NOT_READY", message: "File is not yet available" },
          422,
        );
      }

      // File must belong to this entity or be unattached
      if (file.entityId !== null && file.entityId !== id) {
        return c.json(
          {
            error: "FILE_BELONGS_TO_OTHER_ENTITY",
            message: "File is attached to a different record",
          },
          409,
        );
      }

      // Bind file to entity if not yet set
      if (file.entityId === null) {
        await withTenantContext(tenantId, (tx) =>
          tx
            .update(files)
            .set({ entityId: id, updatedAt: new Date() })
            .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId))),
        );
      }

      const existingFileIds: string[] = Array.isArray(metadata.fileIds)
        ? (metadata.fileIds as string[])
        : [];

      if (existingFileIds.includes(fileId)) {
        // Already attached — idempotent
        return c.json({ data: event }, 200);
      }

      const [updated] = await withTenantContext(tenantId, (tx) =>
        tx
          .update(workflowEvents)
          .set({
            metadata: sql`jsonb_set(
              metadata,
              '{fileIds}',
              COALESCE(metadata->'fileIds', '[]'::jsonb) || to_jsonb(${fileId}::text)
            )`,
          })
          .where(
            and(
              eq(workflowEvents.id, eventId),
              eq(workflowEvents.tenantId, tenantId),
            ),
          )
          .returning(),
      );

      return c.json({ data: updated }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
