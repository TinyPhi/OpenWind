import { zValidator } from "../../lib/validator.js";
import { requireAuth } from "@platform/auth";
import { withTenantAndUserContext, savedViews } from "@platform/db";
import { eq, and } from "drizzle-orm";
import { factory } from "./factory.js";
import { ListSavedViewsQuerySchema } from "./schemas.js";

export const listSavedViewsHandler = factory.createHandlers(
  requireAuth(),
  zValidator("query", ListSavedViewsQuerySchema),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const { entityTypeId } = c.req.valid("query");

    const rows = await withTenantAndUserContext(tenantId, userId, (tx) =>
      tx
        .select()
        .from(savedViews)
        .where(
          and(
            eq(savedViews.tenantId, tenantId),
            eq(savedViews.userId, userId),
            eq(savedViews.entityTypeId, entityTypeId),
          ),
        )
        .orderBy(savedViews.createdAt),
    );

    return c.json({ data: rows });
  },
);
