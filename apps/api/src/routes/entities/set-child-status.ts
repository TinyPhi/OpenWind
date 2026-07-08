import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { db, entityInstances, withTenantContext } from "@platform/db";
import { getParentId, updateEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const SetChildStatusSchema = z.object({
  status: z.enum(["open", "closed"]),
});

export const setChildStatusHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", SetChildStatusSchema),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { status } = c.req.valid("json");
    const { tenantId, userId, roles } = c.get("auth");
    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    try {
      // Verify this is actually a child ticket
      const parentId = await getParentId(db, tenantId, instanceId);
      if (!parentId) {
        return c.json(
          {
            error: "NOT_A_CHILD_TICKET",
            message:
              "This ticket has no parent — child-status only applies to child tickets",
          },
          422,
        );
      }

      if (!isPrivileged) {
        const [child] = await withTenantContext(tenantId, (tx) =>
          tx
            .select({
              assignedTo: entityInstances.assignedTo,
              createdBy: entityInstances.createdBy,
              fields: entityInstances.fields,
            })
            .from(entityInstances)
            .where(
              and(
                eq(entityInstances.id, instanceId),
                eq(entityInstances.tenantId, tenantId),
              ),
            )
            .limit(1),
        );

        const accessUsers =
          (child?.fields as Record<string, unknown> | undefined)
            ?.__accessUsers ?? {};
        const userAccess = (accessUsers as Record<string, { level: string }>)[
          userId
        ];
        const canAccess =
          child?.createdBy === userId ||
          child?.assignedTo === userId ||
          userAccess?.level === "read_write";

        if (!canAccess) {
          return c.json(
            { error: "NOT_FOUND", message: "Record not found" },
            404,
          );
        }
      }

      const instance = await withTenantContext(tenantId, (tx) =>
        updateEntity(tx, tenantId, instanceId, {
          currentState: status,
          fields: { child_status: status },
          actorId: userId,
          actorType: "user",
        }),
      );
      return c.json({ data: instance });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
