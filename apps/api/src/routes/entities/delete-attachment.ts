import { requireAuth } from "@platform/auth";
import {
  entityInstances,
  files,
  workflowEvents,
  withTenantContext,
} from "@platform/db";
import { and, eq, isNull } from "drizzle-orm";
import { entityRelations } from "@platform/db";
import { deleteFile } from "@platform/files";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

export const deleteAttachmentHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const fileId = c.req.param("fileId") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    try {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            id: entityInstances.id,
            workflowId: entityInstances.workflowId,
            currentState: entityInstances.currentState,
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

      // Ensure the file actually belongs to this entity (prevents cross-entity delete)
      if (file.entityId !== id) {
        return c.json({ error: "NOT_FOUND", message: "File not found" }, 404);
      }

      // Only the uploader, admin/agent, or an admin of this ticket's workflow
      // can delete
      if (!isPrivileged && file.uploadedBy !== userId) {
        const canDelete = instance.workflowId
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
        if (!canDelete) {
          return c.json({ error: "NOT_FOUND", message: "File not found" }, 404);
        }
      }

      // deleteFile opens its own db.transaction() internally; passing the
      // withTenantContext tx (not the raw db import) keeps that nested
      // transaction under the same SET LOCAL ROLE app_user + tenant GUC as
      // the outer one, so RLS still applies (M-3).
      await withTenantContext(tenantId, (tx) =>
        deleteFile(tx, tenantId, fileId),
      );

      // Emit file_deleted history event (best-effort)
      let workflowId = instance.workflowId;
      if (!workflowId) {
        const [parentRel] = await withTenantContext(tenantId, (tx) =>
          tx
            .select({ toInstanceId: entityRelations.toInstanceId })
            .from(entityRelations)
            .where(
              and(
                eq(entityRelations.fromInstanceId, id),
                eq(entityRelations.tenantId, tenantId),
                eq(entityRelations.relationType, "child_of"),
                isNull(entityRelations.deletedAt),
              ),
            )
            .limit(1),
        );
        if (parentRel) {
          const [parent] = await withTenantContext(tenantId, (tx) =>
            tx
              .select({ workflowId: entityInstances.workflowId })
              .from(entityInstances)
              .where(
                and(
                  eq(entityInstances.id, parentRel.toInstanceId),
                  eq(entityInstances.tenantId, tenantId),
                ),
              )
              .limit(1),
          );
          workflowId = parent?.workflowId ?? null;
        }
      }

      if (workflowId) {
        await withTenantContext(tenantId, (tx) =>
          tx.insert(workflowEvents).values({
            tenantId,
            instanceId: id,
            workflowId,
            fromState: instance.currentState,
            toState: instance.currentState,
            triggeredBy: "user",
            actorId: userId,
            comment: null,
            metadata: {
              type: "file_deleted",
              fileId,
              originalName: file.originalName,
              mimeType: file.mimeType,
            },
          }),
        );
      }

      return c.body(null, 204);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
