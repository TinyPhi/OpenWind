import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { entityInstances, tenantUsers, withTenantContext } from "@platform/db";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { emitAccessEvent } from "../../lib/emit-access-event.js";

const GrantAccessSchema = z.object({
  userId: z.string().min(1),
  level: z
    .enum(["read_only", "read_comment", "read_write"])
    .default("read_comment"),
  tag: z.enum(["mention", "manual", "assigned"]).default("manual"),
});

export const grantAccessHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", GrantAccessSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId: actorId, roles } = c.get("auth");
    const isPrivileged = roles.includes("admin") || roles.includes("agent");
    const { userId, level, tag } = c.req.valid("json");

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

      // No isOwner path here (unlike revoke-access.ts/update-access.ts): a
      // direct, unprompted grant is intentionally admin/workflow-admin-only —
      // a plain owner must go through the request/approve flow instead. See
      // resolve-access-request.ts's identical rationale comment.
      if (!isPrivileged) {
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
        if (!isRecordWorkflowAdmin) {
          return c.json(
            { error: "NOT_FOUND", message: "Record not found" },
            404,
          );
        }
      }

      // Reject granting access to a userId that isn't actually a member of
      // this tenant — the schema only validates that userId is a non-empty
      // string, so without this check any caller-supplied ID would be
      // written into __accessUsers unchecked.
      const [targetUser] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ userId: tenantUsers.userId })
          .from(tenantUsers)
          .where(
            and(
              eq(tenantUsers.tenantId, tenantId),
              eq(tenantUsers.userId, userId),
            ),
          )
          .limit(1),
      );
      if (!targetUser) {
        return c.json(
          { error: "NOT_FOUND", message: "User not found in this tenant" },
          404,
        );
      }

      // Merge new entry into the __accessUsers object map.
      // Guard against legacy array format — coerce to {} so jsonb_set path works.
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
              ARRAY['__accessUsers', ${userId}::text],
              jsonb_build_object('level', to_jsonb(${level}::text), 'tag', to_jsonb(${tag}::text))
            )`,
          })
          .where(
            and(
              eq(entityInstances.id, id),
              eq(entityInstances.tenantId, tenantId),
            ),
          ),
      );

      void emitAccessEvent(tenantId, id, actorId, {
        type: "access_grant",
        targetUserId: userId,
        level,
        tag,
      });

      return c.json({ data: { granted: true } }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
