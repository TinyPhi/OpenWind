import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole, requireIntrospection } from "@platform/auth";
import { withTenantContext, apiKeys } from "@platform/db";
import { eq } from "drizzle-orm";
import { factory } from "./factory.js";

const ListApiKeysQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listApiKeysHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  requireIntrospection(),
  zValidator("query", ListApiKeysQuerySchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const { limit, offset } = c.req.valid("query");

    const rows = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          lastUsedAt: apiKeys.lastUsedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.tenantId, tenantId))
        .orderBy(apiKeys.createdAt)
        .limit(limit)
        .offset(offset),
    );

    return c.json({ data: rows });
  },
);
