import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import {
  getEntity,
  listRelations,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
// Same hasEntityReadAccess gate get.ts/list-children.ts apply to this exact
// record — without it, any tenant member can enumerate a ticket's relation
// graph (linked/parent/child record IDs) by guessing its ID.
import { hasEntityReadAccess } from "../../lib/entity-access.js";

const ListRelationsQuerySchema = z.object({
  direction: z.enum(["from", "to", "both"]).optional(),
  relationType: z.string().min(1).optional(),
  cursor: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

export const listRelationsHandler = factory.createHandlers(
  requireAuth(),
  zValidator("query", ListRelationsQuerySchema),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const query = c.req.valid("query");
    const { tenantId, userId, roles } = c.get("auth");

    try {
      const instance = await withTenantContext(tenantId, (tx) =>
        getEntity(tx, tenantId, instanceId),
      );

      if (!hasEntityReadAccess(instance, userId, roles)) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      const page = await withTenantContext(tenantId, (tx) =>
        listRelations(tx, tenantId, instanceId, {
          direction: query.direction,
          relationType: query.relationType,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
      return c.json({ data: page.data, nextCursor: page.nextCursor });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
