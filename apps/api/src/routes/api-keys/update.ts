import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole, requireIntrospection } from "@platform/auth";
import { withTenantContext, apiKeys } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import { and, eq, isNull } from "drizzle-orm";
import { factory } from "./factory.js";

// ADR-012 Phase A (PR A5): only these two fields are ever editable after
// creation. name, scopes, and oidcClientId are security/identity-defining
// — spec R8/§V already declares scopes immutable ("need different
// permissions -> issue a new key"), and the same reasoning applies to
// oidcClientId (it identifies WHICH external application the key belongs
// to; changing it is a different registration, not an edit) and name.
// applicationDescription/applicationContactEmail are purely informational —
// changing them has no security or authorization effect, so unlike the
// fields above they don't need rotation to change (standard practice, same
// as Stripe/GitHub/AWS letting you edit a key's label without regenerating
// the credential).
const UpdateApiKeySchema = z
  .object({
    applicationDescription: z.string().max(2000).nullable().optional(),
    applicationContactEmail: z.string().email().optional(),
  })
  .strict();

export const updateApiKeyHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  requireIntrospection(),
  zValidator("json", UpdateApiKeySchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId } = c.get("auth");
    const patch = c.req.valid("json");

    if (Object.keys(patch).length === 0) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message:
            "At least one of applicationDescription or applicationContactEmail is required",
        },
        422,
      );
    }

    const updated = await withTenantContext(tenantId, async (tx) => {
      const rows = await tx
        .update(apiKeys)
        .set(patch)
        .where(
          and(
            eq(apiKeys.id, id),
            eq(apiKeys.tenantId, tenantId),
            isNull(apiKeys.revokedAt),
            eq(apiKeys.scopesFormat, "action"),
          ),
        )
        .returning({
          id: apiKeys.id,
          name: apiKeys.name,
          applicationName: apiKeys.applicationName,
          applicationDescription: apiKeys.applicationDescription,
          applicationContactEmail: apiKeys.applicationContactEmail,
        });

      const row = rows[0];
      if (row) {
        await writeAuditEntry(tx, {
          tenantId,
          actorId: userId,
          actorType: "user",
          resourceType: "api_key",
          resourceId: id,
          action: "updated",
          afterSnapshot: {
            applicationDescription: row.applicationDescription,
            applicationContactEmail: row.applicationContactEmail,
          },
        });
      }

      return rows;
    });

    const row = updated[0];
    if (!row) {
      return c.json({ error: "NOT_FOUND", message: "API key not found" }, 404);
    }

    return c.json({ data: row });
  },
);
