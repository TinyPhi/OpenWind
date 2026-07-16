import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import {
  listRelations,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

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
    const { tenantId } = c.get("auth");

    try {
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
