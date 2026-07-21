import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { entityInstances, withTenantContext } from "@platform/db";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { emitAccessEvent } from "../../lib/emit-access-event.js";

const UpdateAccessSchema = z.object({
  level: z.enum(["read_only", "read_comment", "read_write"]),
});

export const updateAccessHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", UpdateAccessSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const targetUserId = c.req.param("userId") ?? "";
    const { tenantId, userId: actorId, roles } = c.get("auth");
    const { level } = c.req.valid("json");
    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    try {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            id: entityInstances.id,
            assignedTo: entityInstances.assignedTo,
            fields: entityInstances.fields,
            createdBy: entityInstances.createdBy,
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

      if (!isPrivileged) {
        const isOwner =
          instance.createdBy === actorId || instance.assignedTo === actorId;
        const isRecordWorkflowAdmin = instance.workflowId
          ? isWorkflowAdmin(
              actorId,
              await withTenantContext(tenantId, (tx) =>
                getWorkflow(tx, tenantId, instance.workflowId as string, {
                  userId: actorId,
                  isGlobalAdmin: false,
                }),
              ),
            )
          : false;
        if (!isOwner && !isRecordWorkflowAdmin) {
          return c.json(
            { error: "NOT_FOUND", message: "Record not found" },
            404,
          );
        }
      }

      // This is an update, not a grant — the target user must already have
      // an ACL entry. The 3-element jsonb_set path used previously
      // (['__accessUsers', userId, 'level']) let Postgres auto-create the
      // intermediate object when absent, producing a {level} entry with no
      // `tag` that downstream readers (e.g. my-tickets.ts) silently misread.
      const accessUsers =
        (instance.fields as Record<string, unknown> | null)?.__accessUsers ??
        {};
      const existingEntry = (
        accessUsers as Record<string, { level: string; tag?: string }>
      )[targetUserId];

      if (!existingEntry) {
        return c.json(
          {
            error: "ACCESS_ENTRY_NOT_FOUND",
            message: "User has no existing access grant to update",
          },
          404,
        );
      }

      // Update the level field inside __accessUsers[targetUserId]
      // Guard against legacy array format — coerce to {} so path navigation works.
      await withTenantContext(tenantId, (tx) =>
        tx
          .update(entityInstances)
          .set({
            fields: sql`jsonb_set(
              fields,
              ARRAY['__accessUsers', ${targetUserId}::text],
              jsonb_build_object(
                'level', to_jsonb(${level}::text),
                'tag', to_jsonb(${existingEntry.tag ?? "manual"}::text)
              )
            )`,
            // If downgrading from read_write (i.e. was assigned) — unassign
            ...(instance.assignedTo === targetUserId && level !== "read_write"
              ? { assignedTo: sql`NULL` }
              : {}),
          })
          .where(
            and(
              eq(entityInstances.id, id),
              eq(entityInstances.tenantId, tenantId),
            ),
          ),
      );

      void emitAccessEvent(tenantId, id, actorId, {
        type: "access_update",
        targetUserId,
        level,
      });

      return c.json({ data: { updated: true } });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
