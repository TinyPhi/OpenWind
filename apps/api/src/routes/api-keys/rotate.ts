import { randomBytes } from "node:crypto";
import {
  requireAuth,
  requireRole,
  requireIntrospection,
  hashApiKey,
  hashApiKeyArgon2,
  API_KEY_DEFAULT_TTL_DAYS,
  API_KEY_ROTATION_OVERLAP_HOURS,
} from "@platform/auth";
import { withTenantContext, apiKeys } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { factory } from "./factory.js";
import { scopeCeilingError } from "./scope-ceiling.js";

export const rotateApiKeyHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  requireIntrospection(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, roles, userId } = c.get("auth");

    const result = await withTenantContext(tenantId, async (tx) => {
      // Eligibility mirrors resolve_api_key_by_hash exactly (migration 0053):
      // an already-expired-but-not-revoked key must not be rotatable — that
      // would let rotation resurrect a dead credential instead of only ever
      // shortening its remaining life (see the overlap-window update below).
      const [original] = await tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          scopesFormat: apiKeys.scopesFormat,
          expiresAt: apiKeys.expiresAt,
        })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.id, id),
            eq(apiKeys.tenantId, tenantId),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          ),
        )
        .limit(1);

      if (!original) return { error: "not_found" as const };

      // Re-checked here, not just at original creation time (#223) — a caller
      // whose roles have since been downgraded should not be able to use
      // rotation to keep reissuing scopes they no longer hold themselves.
      const scopeError = scopeCeilingError(roles, original.scopes);
      if (scopeError) return { error: "forbidden" as const, scopeError };

      // Generated only once eligibility + scope checks pass — hashApiKeyArgon2
      // is intentionally slow (~100-250ms); doing this before the checks above
      // would burn a full argon2id computation on every invalid/cross-tenant
      // rotate attempt for no reason (review finding, PR #361).
      const rawKey = `sk_live_${randomBytes(32).toString("base64url")}`;
      const keyHash = hashApiKey(rawKey);
      const keyHashArgon2 = await hashApiKeyArgon2(rawKey);
      const expiresAt = new Date(
        Date.now() + API_KEY_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000,
      );
      const overlapExpiresAt = new Date(
        Date.now() + API_KEY_ROTATION_OVERLAP_HOURS * 60 * 60 * 1000,
      );

      const [created] = await tx
        .insert(apiKeys)
        .values({
          tenantId,
          name: original.name,
          scopes: original.scopes,
          // Carried forward unchanged, not recomputed — rotation reissues the
          // same scopes verbatim, so it must keep whatever format they were
          // already recorded as (ADR-008 Decision #6).
          scopesFormat: original.scopesFormat,
          keyHash,
          keyHashArgon2,
          createdBy: userId,
          expiresAt,
          rotatedFrom: original.id,
        })
        .returning({
          id: apiKeys.id,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          scopesFormat: apiKeys.scopesFormat,
          createdAt: apiKeys.createdAt,
          expiresAt: apiKeys.expiresAt,
        });
      if (!created) {
        throw new Error("api_keys insert returned no row");
      }

      // Dual-valid overlap window (ADR-008 Decision #3): the original stays
      // usable until overlapExpiresAt instead of being killed immediately, so
      // in-flight callers get a chance to pick up the replacement. It then
      // stops resolving on its own via the same expiry check every key goes
      // through (migration 0053) — no separate revoke step or scheduled job.
      // Only ever SHORTENS the original's expiresAt, never extends it — a key
      // already due to expire sooner than the overlap window keeps its
      // existing (sooner) expiry, so rotation can't accidentally resurrect a
      // credential for longer than it was already going to live.
      const newExpiresAt =
        original.expiresAt !== null && original.expiresAt < overlapExpiresAt
          ? original.expiresAt
          : overlapExpiresAt;
      await tx
        .update(apiKeys)
        .set({ expiresAt: newExpiresAt })
        .where(
          and(eq(apiKeys.id, original.id), eq(apiKeys.tenantId, tenantId)),
        );

      await writeAuditEntry(tx, {
        tenantId,
        actorId: userId,
        actorType: "user",
        resourceId: created.id,
        resourceType: "api_key",
        action: "created",
        afterSnapshot: {
          name: created.name,
          scopes: created.scopes,
          scopesFormat: created.scopesFormat,
          expiresAt: created.expiresAt,
        },
        metadata: { rotatedFrom: original.id },
      });

      return { created, rawKey };
    });

    if ("error" in result) {
      if (result.error === "forbidden") {
        return c.json({ error: "FORBIDDEN", message: result.scopeError }, 403);
      }
      return c.json({ error: "NOT_FOUND", message: "API key not found" }, 404);
    }

    return c.json(
      {
        data: {
          ...result.created,
          // Raw key is only returned here — it cannot be recovered later
          key: result.rawKey,
        },
      },
      201,
    );
  },
);
