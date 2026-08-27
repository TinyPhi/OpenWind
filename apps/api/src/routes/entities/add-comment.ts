import { zValidator } from "../../lib/validator.js";
import { logger } from "@platform/logger";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import {
  workflowEvents,
  entityInstances,
  entityRelations,
  tenantUsers,
  files,
  outboxEvents,
  withTenantContext,
} from "@platform/db";
import { isNull } from "drizzle-orm";
import { listOrgUsers } from "../../lib/zitadel-management.js";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { hasEntityCommentAccessFull } from "../../lib/entity-access.js";

const MentionSchema = z.object({
  userId: z.string().min(1),
  // read_write included: the frontend preserves an already-mentioned user's
  // existing access level (e.g. the assignee already has read_write) rather
  // than downgrading them, so a mention entry can legitimately carry any of
  // the three levels, not just the two a *fresh* mention-grant would use.
  level: z
    .enum(["read_only", "read_comment", "read_write"])
    .default("read_comment"),
});

const AddCommentSchema = z.object({
  text: z.string().min(1).max(4000),
  mentions: z.array(MentionSchema).default([]),
  replyTo: z.string().uuid().nullable().default(null),
  fileIds: z.array(z.string().uuid()).max(10).default([]),
});

export const addCommentHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
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
      let canComment: boolean;
      try {
        canComment = await withTenantContext(tenantId, (tx) =>
          hasEntityCommentAccessFull(tx, tenantId, instance, userId, roles),
        );
      } catch (err) {
        return handleEntityError(c, err);
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

    // Who may grant access to a third party via @mention — mirrors exactly
    // who revoke-access.ts already trusts to manage this record's access
    // (admin/agent role, OR the creator/assignee, OR a workflow admin), so a
    // user allowed to revoke access is also allowed to re-grant it via
    // mention. Without this, a creator/assignee logged in without the global
    // admin/agent role could revoke access but never re-grant it — the
    // mention would silently fall into the plain "mentioned" bucket instead
    // of actually granting access.
    const isOwner =
      instance.createdBy === userId || instance.assignedTo === userId;
    let isRecordWorkflowAdmin = false;
    if (
      mentionUserIds.length > 0 &&
      !isPrivileged &&
      !isOwner &&
      instance.workflowId
    ) {
      const workflow = await withTenantContext(tenantId, (tx) =>
        getWorkflow(tx, tenantId, instance.workflowId as string, {
          userId,
          isGlobalAdmin: false,
        }),
      );
      isRecordWorkflowAdmin = isWorkflowAdmin(userId, workflow);
    }
    const canGrantAccess = isPrivileged || isOwner || isRecordWorkflowAdmin;

    // Classify mentions once, up front, and reuse for both notification
    // routing (below) and the actual access grant (further down) — a mention
    // that grants brand-new access gets a distinct notification from a plain
    // mention of someone who already had access; a mismatch between these two
    // classifications would mean a user gets told "you have access" when they
    // don't, or vice versa.
    const existingAccessUsers =
      (instance.fields as Record<string, unknown>).__accessUsers ?? {};
    const existingAccessMap = existingAccessUsers as Record<
      string,
      { level: string }
    >;
    const assignedTo = instance.assignedTo;
    const createdBy = instance.createdBy;
    const hasExistingAccess = (uid: string): boolean =>
      Boolean(existingAccessMap[uid]) ||
      assignedTo === uid ||
      createdBy === uid;
    // A mention from a user without grant authority never grants access, so
    // those mentions always fall into the plain "mentioned" bucket, never
    // "granted access" — bypassing grant-access.ts's/revoke-access.ts's own
    // authority checks via @mention is not allowed.
    const mentionsGettingNewAccess = canGrantAccess
      ? mentionUserIds.filter((uid) => !hasExistingAccess(uid))
      : [];
    const mentionsAlreadyHavingAccess = mentionUserIds.filter(
      (uid) => !mentionsGettingNewAccess.includes(uid),
    );

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

    if (!event) {
      return c.json(
        { error: "INTERNAL_ERROR", message: "Failed to record comment" },
        500,
      );
    }

    // Fires for every comment regardless of mentions — feeds the ticket-room
    // WS live-push path (docs/specs/ticket-live-updates.md), independent of
    // the mention/reply outbox writes below which feed per-user inbox
    // notifications instead.
    try {
      await withTenantContext(tenantId, (tx) =>
        tx.insert(outboxEvents).values({
          tenantId,
          eventType: "comment.created",
          version: 1,
          payload: {
            eventType: "comment.created",
            version: 1,
            tenantId,
            instanceId: id,
            actorId: userId,
            commentId: event.id,
          },
        }),
      );
    } catch (outboxErr) {
      logger.warn(
        { outboxErr, tenantId, instanceId: id, eventType: "comment.created" },
        "room-push outbox write failed — live push missed, primary operation succeeded",
      );
    }

    if (mentionsAlreadyHavingAccess.length > 0) {
      await withTenantContext(tenantId, (tx) =>
        tx.insert(outboxEvents).values({
          tenantId,
          eventType: "comment.mentioned",
          version: 1,
          payload: {
            eventType: "comment.mentioned",
            version: 1,
            tenantId,
            instanceId: id,
            actorId: userId,
            mentionedUserIds: mentionsAlreadyHavingAccess,
          },
        }),
      );
    }

    // Reply notification: notify the parent comment's author, distinct from
    // an explicit @mention. workflow_events.actor_id is the commenter — read
    // directly rather than from metadata, no parsing needed.
    if (replyTo) {
      const [parentComment] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ actorId: workflowEvents.actorId })
          .from(workflowEvents)
          .where(
            and(
              eq(workflowEvents.id, replyTo),
              eq(workflowEvents.tenantId, tenantId),
            ),
          )
          .limit(1),
      );

      if (parentComment?.actorId) {
        await withTenantContext(tenantId, (tx) =>
          tx.insert(outboxEvents).values({
            tenantId,
            eventType: "comment.replied",
            version: 1,
            payload: {
              eventType: "comment.replied",
              version: 1,
              tenantId,
              instanceId: id,
              actorId: userId,
              targetUserId: parentComment.actorId,
            },
          }),
        );
      }
    }

    // Add commenter + mentioned users to __accessUsers using double-nested jsonb_set
    // (same pattern as update-access.ts which is proven to work).
    // We write per-user using ARRAY path so each write is surgical and independent.
    try {
      const usersToGrant: Array<{ userId: string; level: string }> = [];

      // Only grant read_comment to the commenter if they have no existing
      // ACL entry at all — a commenter with an existing entry (e.g.
      // read_write from being assigned or explicitly granted) must never be
      // silently downgraded just for posting a comment. Reuses
      // existingAccessMap computed above (for the mention notification split)
      // rather than re-reading instance.fields a second time.
      const existingSelfEntry = existingAccessMap[userId];
      if (userId !== instance.assignedTo && !existingSelfEntry) {
        usersToGrant.push({ userId, level: "read_comment" });
      }
      // Only users with grant authority (see canGrantAccess above) may grant
      // access to a third party via @mention — otherwise any commenter with
      // mere read_comment access could mention an arbitrary user ID and hand
      // them access, bypassing grant-access.ts's own authority check.
      if (canGrantAccess) {
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

      // Fires only once every grant in the loop above has actually
      // succeeded — inserting this before the grant loop (as an earlier
      // revision did) meant a "you've been granted access" notification
      // could be delivered even when the grant write itself failed, since
      // this whole block is wrapped in a catch that logs and swallows
      // rather than rethrowing.
      if (mentionsGettingNewAccess.length > 0) {
        await withTenantContext(tenantId, (tx) =>
          tx.insert(outboxEvents).values({
            tenantId,
            eventType: "comment.mention_access_granted",
            version: 1,
            payload: {
              eventType: "comment.mention_access_granted",
              version: 1,
              tenantId,
              instanceId: id,
              actorId: userId,
              mentionedUserIds: mentionsGettingNewAccess,
            },
          }),
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
