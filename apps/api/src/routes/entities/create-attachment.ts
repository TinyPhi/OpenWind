import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import {
  entityInstances,
  files,
  workflowEvents,
  withTenantContext,
} from "@platform/db";
import { and, eq, isNull } from "drizzle-orm";
import { entityRelations } from "@platform/db";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const CreateAttachmentSchema = z.object({
  fileId: z.string().uuid(),
});

export const createAttachmentHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateAttachmentSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const { fileId } = c.req.valid("json");
    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    try {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            id: entityInstances.id,
            workflowId: entityInstances.workflowId,
            currentState: entityInstances.currentState,
            createdBy: entityInstances.createdBy,
            assignedTo: entityInstances.assignedTo,
            fields: entityInstances.fields,
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

      // Only admin/agent or users with explicit read_write access can upload
      if (!isPrivileged) {
        const accessUsers =
          (instance.fields as Record<string, unknown>).__accessUsers ?? {};
        const userAccess = (accessUsers as Record<string, { level: string }>)[
          userId
        ];
        let canAttach =
          instance.createdBy === userId ||
          instance.assignedTo === userId ||
          userAccess?.level === "read_write";

        if (!canAttach && instance.workflowId) {
          const workflow = await withTenantContext(tenantId, (tx) =>
            getWorkflow(tx, tenantId, instance.workflowId as string, {
              userId,
              isGlobalAdmin: false,
            }),
          );
          canAttach = isWorkflowAdmin(userId, workflow);
        }

        if (!canAttach) {
          return c.json(
            { error: "NOT_FOUND", message: "Record not found" },
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
          {
            error: "FILE_NOT_READY",
            message: "File is not yet available",
          },
          422,
        );
      }

      if (file.entityId !== null && file.entityId !== id) {
        return c.json(
          {
            error: "FILE_BELONGS_TO_OTHER_ENTITY",
            message: "File is attached to a different record",
          },
          409,
        );
      }

      // Bind file to this entity if not already
      if (file.entityId === null) {
        await withTenantContext(tenantId, (tx) =>
          tx
            .update(files)
            .set({ entityId: id, updatedAt: new Date() })
            .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId))),
        );
      }

      // Emit file_attached history event (best-effort — skip if no workflowId)
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
              type: "file_attached",
              fileId,
              originalName: file.originalName,
              mimeType: file.mimeType,
            },
          }),
        );
      }

      return c.json(
        {
          data: {
            id: file.id,
            originalName: file.originalName,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            scanStatus: file.scanStatus,
            uploadedBy: file.uploadedBy,
            createdAt: file.createdAt,
          },
        },
        201,
      );
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
