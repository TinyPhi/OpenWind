import { randomBytes } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  requireAuth,
  requireRole,
  requireIntrospection,
  hashApiKey,
} from "@platform/auth";
import { withTenantContext, apiKeys } from "@platform/db";
import { factory } from "./factory.js";

const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(z.string().min(1)).default([]),
});

export const createApiKeyHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  requireIntrospection(),
  zValidator("json", CreateApiKeySchema),
  async (c) => {
    const { name, scopes } = c.req.valid("json");
    const { tenantId } = c.get("auth");

    // Generate a cryptographically random key with a recognisable prefix.
    // The raw key is returned exactly once — after this the hash is all that
    // is stored.  The caller is responsible for storing it securely.
    const rawKey = `sk_live_${randomBytes(32).toString("base64url")}`;
    const keyHash = hashApiKey(rawKey);

    const [created] = await withTenantContext(tenantId, (tx) =>
      tx
        .insert(apiKeys)
        .values({
          tenantId,
          name,
          keyHash,
          scopes,
        })
        .returning({
          id: apiKeys.id,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          createdAt: apiKeys.createdAt,
        }),
    );

    return c.json(
      {
        data: {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          ...created!,
          // Raw key is only returned here — it cannot be recovered later
          key: rawKey,
        },
      },
      201,
    );
  },
);
