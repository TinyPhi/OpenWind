import { requireAuth, requireRole, requireIntrospection } from "@platform/auth";
import { withTenantContext, apiKeys } from "@platform/db";
import { and, eq } from "drizzle-orm";
import { factory } from "./factory.js";

export const deleteApiKeyHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  requireIntrospection(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");

    // The WHERE clause includes tenantId so a tenant cannot delete another
    // tenant's key — if the key exists but belongs to a different tenant,
    // affected rows will be 0 and we return 404 (not 403), consistent with
    // the platform convention of not leaking resource existence across tenants.
    const deleted = await withTenantContext(tenantId, (tx) =>
      tx
        .delete(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId)))
        .returning({ id: apiKeys.id }),
    );

    if (deleted.length === 0) {
      return c.json({ error: "NOT_FOUND", message: "API key not found" }, 404);
    }

    return c.body(null, 204);
  },
);
