import { requireAuth, requireRole, requireIntrospection } from "@platform/auth";
import { withTenantContext, apiKeys } from "@platform/db";
import { eq } from "drizzle-orm";
import { factory } from "./factory.js";

export const listApiKeysHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  requireIntrospection(),
  async (c) => {
    const { tenantId } = c.get("auth");

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
        .orderBy(apiKeys.createdAt),
    );

    return c.json({ data: rows });
  },
);
