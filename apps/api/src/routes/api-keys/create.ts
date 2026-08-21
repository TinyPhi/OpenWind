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
  detectScopesFormat,
  unknownTicketActionScopes,
} from "@platform/auth";
import { db, withTenantContext, apiKeys } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import { and, eq, isNull } from "drizzle-orm";
import { factory } from "./factory.js";
import { scopeCeilingError } from "./scope-ceiling.js";

// ADR-012 Phase A: the third-party application record is only required when
// the submitted scopes are action-format (i.e. this is a third-party key) —
// the pre-existing internal/role-format key creation flow is unchanged and
// does not need to supply any of these fields.
const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(z.string().min(1)).default([]),
  applicationName: z.string().min(1).max(200).optional(),
  applicationDescription: z.string().max(2000).optional(),
  applicationContactEmail: z.string().email().optional(),
  zitadelClientId: z.string().min(1).max(200).optional(),
});

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

export const createApiKeyHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  requireIntrospection(),
  zValidator("json", CreateApiKeySchema),
  async (c) => {
    const {
      name,
      scopes,
      applicationName,
      applicationDescription,
      applicationContactEmail,
      zitadelClientId,
    } = c.req.valid("json");
    const { tenantId, roles, userId } = c.get("auth");

    // ADR-008 Decision #6: stamps the format of the scopes actually supplied.
    // detectScopesFormat only throws on a mixed role/action array — checked
    // here (before any other validation) so a mixed array fails as a
    // structured 422, not a confusing downstream error.
    let scopesFormat;
    try {
      scopesFormat = detectScopesFormat(scopes);
    } catch (err) {
      return c.json(
        {
          error: "INVALID_SCOPES",
          message: err instanceof Error ? err.message : "Invalid scopes",
        },
        422,
      );
    }

    if (scopesFormat === "role") {
      // Pre-existing internal-key path — unchanged, per this repo's own
      // "leave the old one as it is" decision on this feature.
      const scopeError = scopeCeilingError(roles, scopes);
      if (scopeError) {
        return c.json({ error: "FORBIDDEN", message: scopeError }, 403);
      }
    } else {
      // ADR-012 Decision #3/spec R8: third-party (action-format) keys are
      // never gated by the creator's own role ceiling — the platform's real
      // action-scope system, enforced at request time as scope ∩ person's
      // RBAC ∩ tenant RLS, is the only ceiling that matters for this format.
      // What IS enforced here is that every scope string belongs to the
      // known vocabulary. Spec R8's "scopes must be non-empty" is already
      // guaranteed by construction: detectScopesFormat classifies an empty
      // array as "role" (never "action"), so this branch is unreachable with
      // an empty array in the first place.
      const unknown = unknownTicketActionScopes(scopes);
      if (unknown.length > 0) {
        return c.json(
          {
            error: "INVALID_SCOPES",
            message: `Unknown scope(s): ${unknown.join(", ")}`,
          },
          422,
        );
      }

      // Spec R7: a formal application record is mandatory for a third-party
      // key — these fields are optional at the schema level only so the
      // role-format path above doesn't need to supply dummy values.
      if (!applicationName || !applicationContactEmail || !zitadelClientId) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message:
              "applicationName, applicationContactEmail, and zitadelClientId are required for an action-scoped key",
          },
          422,
        );
      }
    }

    // Generate a cryptographically random key with a recognisable prefix.
    // The raw key is returned exactly once — after this the hash is all that
    // is stored.  The caller is responsible for storing it securely.
    const rawKey = `sk_live_${randomBytes(32).toString("base64url")}`;
    const keyHash = hashApiKey(rawKey);
    const keyHashArgon2 = await hashApiKeyArgon2(rawKey);
    // Spec R6: third-party keys get a fixed 3-month expiry, distinct from
    // the internal-key default TTL (which stays whatever it already was).
    const expiresAt =
      scopesFormat === "action"
        ? new Date(Date.now() + THREE_MONTHS_MS)
        : new Date(Date.now() + API_KEY_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000);

    // Spec R7/§V + migration 0068's own comment: the partial unique index
    // only excludes *revoked* keys from the uniqueness check, not
    // expired-but-not-yet-revoked ones (Postgres partial-index predicates
    // can't reference now()). An expired row therefore still holds its
    // Client ID as far as the DB index is concerned, even though the
    // platform's own invariant says an expired key's Client ID should be
    // reusable, same as a revoked one. Reconciled here: if the conflicting
    // row is actually expired, revoke it as part of reclaiming its Client ID
    // (it was already functionally dead — this just makes that formal) so
    // the DB insert below succeeds instead of hitting the unique-violation.
    // A conflicting row that is NOT expired is a real conflict and is
    // rejected.
    //
    // Runs on the bare `db` client (OUTSIDE withTenantContext), not the
    // tenant-scoped `tx` — a Zitadel Client ID identifies one external
    // application, not one tenant's registration of it (migration 0068's own
    // isolation test), so this check is deliberately global, not per-tenant.
    // Running it inside withTenantContext instead (as an earlier version of
    // this handler did) meant RLS's tenant_read policy hid every other
    // tenant's rows from the query entirely — an *expired* key belonging to
    // a different tenant would never be found and reclaimed, permanently
    // locking that Client ID out for the platform (review finding, PR #440
    // by PrabhuVijit). `db` connects as a superuser that bypasses RLS by
    // design (see client.ts's own comment on this), same precedent already
    // relied on by isTenantActive() for the same "this must see across
    // tenants" reason.
    if (scopesFormat === "action" && zitadelClientId) {
      const [conflict] = await db
        .select({
          id: apiKeys.id,
          expiresAt: apiKeys.expiresAt,
        })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.zitadelClientId, zitadelClientId),
            isNull(apiKeys.revokedAt),
            eq(apiKeys.zitadelClientIdActive, true),
          ),
        );

      if (conflict) {
        const isExpired =
          conflict.expiresAt !== null && conflict.expiresAt <= new Date();
        if (!isExpired) {
          return c.json(
            {
              error: "CLIENT_ID_IN_USE",
              message:
                "This Zitadel Client ID is already registered to another active key",
            },
            409,
          );
        }
        await db
          .update(apiKeys)
          .set({
            revokedAt: new Date(),
            revokedBy: "system:expiry-reclaim",
          })
          .where(eq(apiKeys.id, conflict.id));
      }
    }

    try {
      const created = await withTenantContext(tenantId, async (tx) => {
        let row;
        try {
          [row] = await tx
            .insert(apiKeys)
            .values({
              tenantId,
              name,
              keyHash,
              keyHashArgon2,
              scopes,
              scopesFormat,
              createdBy: userId,
              expiresAt,
              ...(scopesFormat === "action"
                ? {
                    applicationName,
                    applicationDescription,
                    applicationContactEmail,
                    zitadelClientId,
                  }
                : {}),
            })
            .returning({
              id: apiKeys.id,
              name: apiKeys.name,
              scopes: apiKeys.scopes,
              scopesFormat: apiKeys.scopesFormat,
              createdAt: apiKeys.createdAt,
              expiresAt: apiKeys.expiresAt,
              applicationName: apiKeys.applicationName,
              zitadelClientId: apiKeys.zitadelClientId,
            });
        } catch (err) {
          // Defense-in-depth for the race the pre-insert conflict check above
          // can't fully close: two concurrent requests for the same Client ID
          // can both pass that check before either has inserted. Whichever
          // insert loses the race hits the DB's own unique-violation — caught
          // here and translated to the same clean 409 a pre-check-caught
          // conflict gets, rather than leaking a raw DB error as an unhandled
          // 500.
          // Drizzle wraps the raw postgres.js error as a DrizzleQueryError,
          // with the actual PostgresError (code, constraint_name, etc.) on
          // `.cause` — not on the thrown error itself.
          const cause =
            err instanceof Error && "cause" in err ? err.cause : undefined;
          if (
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "23505" &&
            "constraint_name" in cause &&
            cause.constraint_name === "api_keys_zitadel_client_id_active_unique"
          ) {
            throw new ClientIdInUseError();
          }
          throw err;
        }
        if (!row) {
          throw new Error("api_keys insert returned no row");
        }

        // ADR-008 Decision #2: key creation previously wrote no audit entry
        // at all — the "traces back to a human" claim was already false for
        // the api_key principal that exists today.
        await writeAuditEntry(tx, {
          tenantId,
          actorId: userId,
          actorType: "user",
          resourceType: "api_key",
          resourceId: row.id,
          action: "created",
          afterSnapshot: { name, scopes, scopesFormat, expiresAt },
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
    } catch (err) {
      if (err instanceof ClientIdInUseError) {
        return c.json(
          {
            error: "CLIENT_ID_IN_USE",
            message:
              "This Zitadel Client ID is already registered to another active key",
          },
          409,
        );
      }
      throw err;
    }
  },
);

class ClientIdInUseError extends Error {}
