import { randomBytes } from "node:crypto";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import {
  requireAuth,
  requireRole,
  requireIntrospection,
  hashApiKey,
  hashApiKeyArgon2,
  API_KEY_DEFAULT_TTL_DAYS,
} from "@platform/auth";
import { withTenantContext, apiKeys } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import { factory } from "./factory.js";
import { scopeCeilingError } from "./scope-ceiling.js";

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
    const { tenantId, roles, userId } = c.get("auth");

    const scopeError = scopeCeilingError(roles, scopes);
    if (scopeError) {
      return c.json({ error: "FORBIDDEN", message: scopeError }, 403);
    }

    // Generate a cryptographically random key with a recognisable prefix.
    // The raw key is returned exactly once — after this the hash is all that
    // is stored.  The caller is responsible for storing it securely.
    const rawKey = `sk_live_${randomBytes(32).toString("base64url")}`;
    const keyHash = hashApiKey(rawKey);
    const keyHashArgon2 = await hashApiKeyArgon2(rawKey);
    const expiresAt = new Date(
      Date.now() + API_KEY_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const created = await withTenantContext(tenantId, async (tx) => {
      const [row] = await tx
        .insert(apiKeys)
        .values({
          tenantId,
          name,
          keyHash,
          keyHashArgon2,
          scopes,
          createdBy: userId,
          expiresAt,
        })
        .returning({
          id: apiKeys.id,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          createdAt: apiKeys.createdAt,
          expiresAt: apiKeys.expiresAt,
        });
      if (!row) {
        throw new Error("api_keys insert returned no row");
      }

      // ADR-008 Decision #2: key creation previously wrote no audit entry at
      // all — the "traces back to a human" claim was already false for the
      // api_key principal that exists today.
      await writeAuditEntry(tx, {
        tenantId,
        actorId: userId,
        actorType: "user",
        resourceType: "api_key",
        resourceId: row.id,
        action: "created",
        afterSnapshot: { name, scopes },
      });

      return row;
    });

    return c.json(
      {
        data: {
          ...created,
          // Raw key is only returned here — it cannot be recovered later
          key: rawKey,
        },
      },
      201,
    );
  },
);
