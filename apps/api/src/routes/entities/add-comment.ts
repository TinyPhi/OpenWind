import { zValidator } from "../../lib/validator.js";
import { logger } from "@platform/logger";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth } from "@platform/auth";
import {
  workflowEvents,
  entityInstances,
  entityRelations,
  tenantUsers,
  files,
  withTenantContext,
} from "@platform/db";
import { isNull } from "drizzle-orm";
import { listOrgUsers } from "../../lib/zitadel-management.js";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const MentionSchema = z.object({
  userId: z.string().min(1),
  level: z.enum(["read_only", "read_comment"]).default("read_comment"),
});

const AddCommentSchema = z.object({
  text: z.string().min(1).max(4000),
  mentions: z.array(MentionSchema).default([]),
  replyTo: z.string().uuid().nullable().default(null),
  fileIds: z.array(z.string().uuid()).max(10).default([]),
});

export const addCommentHandler = factory.createHandlers(
  requireAuth(),
  zValidator("json", AddCommentSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, orgId, roles } = c.get("auth");
    const { text, mentions, replyTo, fileIds } = c.req.valid("json");
    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    const [instance] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          id: entityInstances.id,
          workflowId: entityInstances.workflowId,
          currentState: entityInstances.currentState,
          assignedTo: entityInstances.assignedTo,
          createdBy: entityInstances.createdBy,
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

    if (!isPrivileged) {
      const accessUsers =
        (instance.fields as Record<string, unknown>).__accessUsers ?? {};
      const userAccess = (accessUsers as Record<string, { level: string }>)[
        userId
      ];
      let canComment =
        instance.createdBy === userId ||
        instance.assignedTo === userId ||
        userAccess?.level === "read_comment" ||
        userAccess?.level === "read_write";

      if (!canComment && instance.workflowId) {
        try {
          const workflow = await withTenantContext(tenantId, (tx) =>
            getWorkflow(tx, tenantId, instance.workflowId as string, {
              userId,
              isGlobalAdmin: false,
            }),
          );
          canComment = isWorkflowAdmin(userId, workflow);
        } catch (err) {
          return handleEntityError(c, err);
        }
      }

      if (!canComment) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }
    }

    // Resolve workflowId — child tickets created before the inheritance fix may have null.
    // Walk up to the parent to get its workflowId.
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
    if (!workflowId) {
      return c.json(
        { error: "BAD_REQUEST", message: "Record has no workflow" },
        400,
      );
    }

    // Validate + bind every fileId before it can be written into comment
    // metadata — otherwise an unbound file's entityId stays null, and
    // files/download.ts's hasEntityAccess gate is `if (file.entityId)`,
    // meaning any same-tenant user could fetch a download URL for it by ID,
    // bypassing this record's own access control. Mirrors create-attachment.ts.
    if (fileIds.length > 0) {
      for (const fileId of fileIds) {
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
        if (file.entityId !== null && file.entityId !== id) {
          return c.json(
            {
              error: "FILE_BELONGS_TO_OTHER_ENTITY",
              message: "File is attached to a different record",
            },
            409,
          );
        }
        if (file.entityId === null) {
          await withTenantContext(tenantId, (tx) =>
            tx
              .update(files)
              .set({ entityId: id, updatedAt: new Date() })
              .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId))),
          );
        }
      }
    }

    // Resolve actor name
    const [dbUser] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          displayName: tenantUsers.displayName,
          email: tenantUsers.email,
        })
        .from(tenantUsers)
        .where(
          and(
            eq(tenantUsers.userId, userId),
            eq(tenantUsers.tenantId, tenantId),
          ),
        )
        .limit(1),
    );

    let actorName: string | null = null;
    if (dbUser?.displayName && dbUser.displayName !== userId) {
      actorName = dbUser.displayName;
    } else if (dbUser?.email && dbUser.email !== userId) {
      try {
        const zUsers = orgId ? await listOrgUsers(orgId) : [];
        const zUser = zUsers.find((u) => u.userId === userId);
        actorName = zUser?.displayName ?? zUser?.loginName ?? dbUser.email;
      } catch {
        actorName = dbUser.email;
      }
    }

    const mentionUserIds = mentions.map((m) => m.userId);

    const [event] = await withTenantContext(tenantId, (tx) =>
      tx
        .insert(workflowEvents)
        .values({
          tenantId,
          instanceId: id,
          workflowId,
          fromState: instance.currentState,
          toState: instance.currentState,
          triggeredBy: "user",
          actorId: userId,
          comment: null,
          metadata: {
            type: "comment",
            text,
            mentions: mentionUserIds,
            replyTo,
            actorName,
            ...(fileIds.length > 0 && { fileIds }),
          },
        })
        .returning(),
    );

    // Add commenter + mentioned users to __accessUsers using double-nested jsonb_set
    // (same pattern as update-access.ts which is proven to work).
    // We write per-user using ARRAY path so each write is surgical and independent.
    try {
      const usersToGrant: Array<{ userId: string; level: string }> = [];

      // Only grant read_comment to the commenter if they have no existing
      // ACL entry at all — a commenter with an existing entry (e.g.
      // read_write from being assigned or explicitly granted) must never be
      // silently downgraded just for posting a comment.
      const existingAccessUsers =
        (instance.fields as Record<string, unknown>).__accessUsers ?? {};
      const existingSelfEntry = (
        existingAccessUsers as Record<string, { level: string }>
      )[userId];
      if (userId !== instance.assignedTo && !existingSelfEntry) {
        usersToGrant.push({ userId, level: "read_comment" });
      }
      // Only admins/agents may grant access to a third party via @mention —
      // otherwise any commenter with mere read_comment access could mention an
      // arbitrary user ID and hand them access, bypassing grant-access.ts's
      // requireRole("admin", "agent") gate on the equivalent mutation.
      if (isPrivileged) {
        for (const mention of mentions) {
          if (!usersToGrant.some((u) => u.userId === mention.userId)) {
            usersToGrant.push({ userId: mention.userId, level: mention.level });
          }
        }
      }

      logger.info(
        { instanceId: id, tenantId, usersToGrant },
        "add-comment: granting access",
      );

      for (const grant of usersToGrant) {
        await withTenantContext(tenantId, (tx) =>
          tx
            .update(entityInstances)
            .set({
              fields: sql`jsonb_set(
                jsonb_set(
                  fields,
                  '{__accessUsers}',
                  CASE
                    WHEN jsonb_typeof(COALESCE(fields->'__accessUsers', 'null'::jsonb)) = 'object'
                    THEN fields->'__accessUsers'
                    ELSE '{}'::jsonb
                  END
                ),
                ARRAY['__accessUsers', ${grant.userId}::text],
                jsonb_build_object('level', to_jsonb(${grant.level}::text), 'tag', 'mention')
              )`,
            })
            .where(
              and(
                eq(entityInstances.id, id),
                eq(entityInstances.tenantId, tenantId),
              ),
            ),
        );
        logger.info(
          { userId: grant.userId, level: grant.level },
          "add-comment: access granted",
        );
      }
    } catch (accessErr) {
      logger.error(
        { instanceId: id, tenantId, error: String(accessErr) },
        "add-comment: access grant failed",
      );
    }

    return c.json({ data: event }, 201);
  },
);
