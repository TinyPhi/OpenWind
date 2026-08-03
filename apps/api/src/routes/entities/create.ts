import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { tenantUsers, withTenantContext } from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { listUserIdsWithRole } from "../../lib/zitadel-management.js";

const CreateEntitySchema = z.object({
  entityTypeId: z.string().uuid(),
  fields: z.record(z.unknown()),
  createdBy: z.string().optional(),
  assignedTo: z.string().optional(),
  workflowId: z.string().uuid().optional(),
  currentState: z.string().optional(),
});

export const createEntityHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateEntitySchema),
  async (c) => {
    const { tenantId, userId, orgId } = c.get("auth");
    const input = c.req.valid("json");

    // assignedTo must resolve to a real tenant member holding the "user" role —
    // the same pool GET /platform/users exposes. Role membership is Zitadel-side
    // (tenant_users has no role column), scoped by orgId, so this also rejects a
    // cross-tenant user id (they simply won't appear in this org's role set).
    // Fail closed (no orgId → reject) rather than silently skipping the check.
    if (input.assignedTo !== undefined) {
      const usersWithRole = orgId
        ? await listUserIdsWithRole(orgId, "user")
        : new Set<string>();
      if (!usersWithRole.has(input.assignedTo)) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: {
              assignedTo:
                "Must be an existing tenant member with the 'user' role",
            },
          },
          422,
        );
      }
    }

    try {
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
      const actorName =
        dbUser?.displayName && dbUser.displayName !== userId
          ? dbUser.displayName
          : dbUser?.email && dbUser.email !== userId
            ? dbUser.email
            : null;

      const instance = await withTenantContext(tenantId, (tx) =>
        createEntity(tx, tenantId, {
          ...input,
          actorId: userId,
          actorName: actorName ?? undefined,
          // Prefer createdBy from body if provided; fall back to authenticated user.
          createdBy: input.createdBy ?? userId,
        }),
      );
      return c.json({ data: instance }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
