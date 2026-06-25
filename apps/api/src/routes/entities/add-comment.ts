import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@platform/auth";
import {
  workflowEvents,
  entityInstances,
  tenantUsers,
  withTenantContext,
} from "@platform/db";
import { listOrgUsers } from "../../lib/zitadel-management.js";
import { factory } from "./factory.js";

const AddCommentSchema = z.object({
  text: z.string().min(1).max(4000),
  mentions: z.array(z.string()).default([]),
  replyTo: z.string().uuid().nullable().default(null),
});

export const addCommentHandler = factory.createHandlers(
  requireAuth(),
  zValidator("json", AddCommentSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, orgId, roles } = c.get("auth");
    const { text, mentions, replyTo } = c.req.valid("json");
    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    // Verify entity exists and belongs to tenant
    const [instance] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          id: entityInstances.id,
          workflowId: entityInstances.workflowId,
          currentState: entityInstances.currentState,
          assignedTo: entityInstances.assignedTo,
          createdBy: entityInstances.createdBy,
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

    // Non-admin/agent users may only comment on records they own (assignee or creator)
    if (
      !isPrivileged &&
      instance.assignedTo !== userId &&
      instance.createdBy !== userId
    ) {
      return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
    }

    if (!instance.workflowId) {
      return c.json(
        { error: "BAD_REQUEST", message: "Record has no workflow" },
        400,
      );
    }
    const workflowId = instance.workflowId;

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
      // Try Zitadel for display name
      try {
        const zUsers = orgId ? await listOrgUsers(orgId) : [];
        const zUser = zUsers.find((u) => u.userId === userId);
        actorName = zUser?.displayName ?? zUser?.loginName ?? dbUser.email;
      } catch {
        actorName = dbUser.email;
      }
    }

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
            mentions,
            replyTo,
            actorName,
          },
        })
        .returning(),
    );

    return c.json({ data: event }, 201);
  },
);
