import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole, requireIntrospection } from "@platform/auth";
import { withTenantContext, apiKeys } from "@platform/db";
import { and, eq, isNull, desc } from "drizzle-orm";
import { factory } from "./factory.js";

const ListApiKeysQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  // ADR-012 Phase A (PR A5): opt-in only — every other caller keeps ADR-008
  // Decision #4's default (revoked keys excluded, since without that filter
  // they'd reappear here forever). The Key Management UI passes this
  // explicitly so it can show the full active/rotating/expired/revoked
  // lifecycle per spec R10, without changing the default for anyone else.
  includeRevoked: z.coerce.boolean().default(false),
});

export const listApiKeysHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  requireIntrospection(),
  zValidator("query", ListApiKeysQuerySchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const { limit, offset, includeRevoked } = c.req.valid("query");

    const rows = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          scopesFormat: apiKeys.scopesFormat,
          applicationName: apiKeys.applicationName,
          applicationDescription: apiKeys.applicationDescription,
          applicationContactEmail: apiKeys.applicationContactEmail,
          rotatedFrom: apiKeys.rotatedFrom,
          lastUsedAt: apiKeys.lastUsedAt,
          createdAt: apiKeys.createdAt,
          createdBy: apiKeys.createdBy,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(
          includeRevoked
            ? eq(apiKeys.tenantId, tenantId)
            : and(eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)),
        )
        .orderBy(desc(apiKeys.createdAt))
        .limit(limit)
        .offset(offset),
    );

    return c.json({ data: rows });
  },
);
