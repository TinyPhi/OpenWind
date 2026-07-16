import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth } from "@platform/auth";
import {
  entityInstances,
  accessRequests,
  withTenantContext,
} from "@platform/db";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { emitAccessEvent } from "../../lib/emit-access-event.js";

const ResolveAccessRequestSchema = z.object({
  action: z.enum(["approve", "reject"]),
  level: z.enum(["read_only", "read_comment", "read_write"]).optional(),
});

export const resolveAccessRequestHandler = factory.createHandlers(
  requireAuth(),
  zValidator("json", ResolveAccessRequestSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const reqId = c.req.param("reqId") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const isAdminOrAgent = roles.includes("admin") || roles.includes("agent");
    const { action, level } = c.req.valid("json");

    try {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            id: entityInstances.id,
            createdBy: entityInstances.createdBy,
            assignedTo: entityInstances.assignedTo,
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

      // Deliberately more permissive than grant/revoke/update-access (which
      // require admin/agent): a ticket owner reviewing requests on their own
      // ticket is the expected path for this feature. The two are not meant
      // to be symmetric — this route only ever grants access the requester
      // explicitly asked for and the owner explicitly approved, whereas the
      // direct ACL routes let a caller set arbitrary access unprompted.
      const isOwner =
        instance.createdBy === userId || instance.assignedTo === userId;
      const isRecordWorkflowAdmin = instance.workflowId
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
      if (!isOwner && !isAdminOrAgent && !isRecordWorkflowAdmin) {
        return c.json({ error: "FORBIDDEN", message: "Not found" }, 404);
      }

      const [req] = await withTenantContext(tenantId, (tx) =>
        tx
          .select()
          .from(accessRequests)
          .where(
            and(
              eq(accessRequests.id, reqId),
              eq(accessRequests.tenantId, tenantId),
              eq(accessRequests.instanceId, id),
            ),
          )
          .limit(1),
      );

      if (!req) {
        return c.json(
          { error: "NOT_FOUND", message: "Request not found" },
          404,
        );
      }

      if (req.status !== "pending") {
        return c.json(
          {
            error: "ACCESS_REQUEST_ALREADY_RESOLVED",
            message: `Request already ${req.status}`,
          },
          422,
        );
      }

      const grantedLevel = level ?? req.requestedLevel;

      // Both writes share one transaction so a resolved-but-ungranted request
      // can never persist on partial failure (was two separate
      // withTenantContext calls). The UPDATE's own WHERE also re-checks
      // status='pending' — the initial SELECT above can't prevent two
      // concurrent resolves from both passing that check before either
      // writes, so the atomicity has to live in this UPDATE's WHERE clause.
      const wasResolved = await withTenantContext(tenantId, async (tx) => {
        const [updated] = await tx
          .update(accessRequests)
          .set({
            status: action === "approve" ? "approved" : "rejected",
            resolvedBy: userId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(accessRequests.id, reqId),
              eq(accessRequests.tenantId, tenantId),
              eq(accessRequests.status, "pending"),
            ),
          )
          .returning({ id: accessRequests.id });

        if (!updated) return false;

        if (action === "approve") {
          // Write the access grant into entity_instances.__accessUsers
          await tx
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
                ARRAY['__accessUsers', ${req.requesterId}::text],
                jsonb_build_object('level', to_jsonb(${grantedLevel}::text), 'tag', to_jsonb('manual'::text))
              )`,
            })
            .where(
              and(
                eq(entityInstances.id, id),
                eq(entityInstances.tenantId, tenantId),
              ),
            );
        }

        return true;
      });

      if (!wasResolved) {
        return c.json(
          {
            error: "ACCESS_REQUEST_ALREADY_RESOLVED",
            message: "Request was already resolved by someone else",
          },
          422,
        );
      }

      if (action === "approve") {
        void emitAccessEvent(tenantId, id, userId, {
          type: "access_grant",
          targetUserId: req.requesterId,
          level: grantedLevel,
          tag: "manual",
        });
      } else {
        void emitAccessEvent(tenantId, id, userId, {
          type: "access_reject",
          targetUserId: req.requesterId,
          level: req.requestedLevel,
        });
      }

      return c.json({ data: { resolved: true } });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
