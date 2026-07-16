import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { searchEntities } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const SearchQuerySchema = z.object({
  type: z.string().uuid(),
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export const searchEntitiesHandler = factory.createHandlers(
  requireAuth(),
  zValidator("query", SearchQuerySchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const { type, q, limit, cursor } = c.req.valid("query");

    try {
      const page = await withTenantContext(tenantId, (tx) =>
        searchEntities(tx, tenantId, {
          entityTypeId: type,
          query: q,
          limit,
          cursor,
        }),
      );
      return c.json({ data: page });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
