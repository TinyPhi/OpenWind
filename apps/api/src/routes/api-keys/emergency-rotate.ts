import { randomBytes } from "node:crypto";
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
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { factory } from "./factory.js";
import { scopeCeilingError } from "./scope-ceiling.js";

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

// ADR-012 Phase A spec R5: a distinct action from Rotate, not a variant of
// it — Rotate's whole point is a 24h dual-valid grace window (rotate.ts);
// Emergency Rotate's whole point is the opposite, an instant zero-grace kill
// for a suspected-compromised key. Kept as a fully separate code path (no
// shared branch with rotate.ts) so a future change to one can never silently
// leak a grace period into the other.
export const emergencyRotateApiKeyHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  requireIntrospection(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, roles, userId } = c.get("auth");

    const result = await withTenantContext(tenantId, async (tx) => {
      // Same eligibility shape as Rotate — a dying (mid-grace, not yet
      // expired) key is a valid Emergency Rotate target too, since the whole
      // point is to let an admin escalate an ordinary rotation into an
      // instant kill if the predecessor turns out to be compromised during
      // its own grace window.
      const [target] = await tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          scopesFormat: apiKeys.scopesFormat,
          applicationName: apiKeys.applicationName,
          applicationDescription: apiKeys.applicationDescription,
          applicationContactEmail: apiKeys.applicationContactEmail,
          zitadelClientId: apiKeys.zitadelClientId,
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

      if (!target) return { error: "not_found" as const };

      // Same re-check as Rotate, same reasoning (#223) — only meaningful for
      // role-format keys; action-format keys are never gated by the
      // creator's own role ceiling (ADR-012 Decision #3).
      if (target.scopesFormat === "role") {
        const scopeError = scopeCeilingError(roles, target.scopes);
        if (scopeError) return { error: "forbidden" as const, scopeError };
      }

      // Spec R5: "if the emergency-rotated key has a live successor (i.e. it
      // was mid-grace as a Rotate predecessor), that successor is also
      // killed instantly and a genuinely new key is issued in place of
      // both." A live successor is any row whose rotatedFrom points at the
      // target and that hasn't itself already been revoked/expired.
      const [liveSuccessor] = await tx
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.tenantId, tenantId),
            eq(apiKeys.rotatedFrom, target.id),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
          ),
        )
        .limit(1);

      // Generated only once eligibility + scope checks pass — same
      // slow-hash-avoidance reasoning as rotate.ts (review finding, PR #361).
      const rawKey = `sk_live_${randomBytes(32).toString("base64url")}`;
      const keyHash = hashApiKey(rawKey);
      const keyHashArgon2 = await hashApiKeyArgon2(rawKey);
      const expiresAt =
        target.scopesFormat === "action"
          ? new Date(Date.now() + THREE_MONTHS_MS)
          : new Date(
              Date.now() + API_KEY_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000,
            );

      const [created] = await tx
        .insert(apiKeys)
        .values({
          tenantId,
          name: target.name,
          scopes: target.scopes,
          scopesFormat: target.scopesFormat,
          keyHash,
          keyHashArgon2,
          createdBy: userId,
          expiresAt,
          rotatedFrom: target.id,
          ...(target.scopesFormat === "action"
            ? {
                applicationName: target.applicationName,
                applicationDescription: target.applicationDescription,
                applicationContactEmail: target.applicationContactEmail,
                zitadelClientId: target.zitadelClientId,
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
      if (!created) {
        throw new Error("api_keys insert returned no row");
      }

      // Zero grace, unlike rotate.ts's shortened-but-nonzero overlap window
      // — revoked_at is set immediately, the defining difference of this
      // endpoint. Because revoked_at is set (not just a shortened expiresAt
      // left at NULL), the target is excluded from the zitadel_client_id
      // partial unique index (migration 0068/0069) the instant this commits
      // — no separate zitadel_client_id_active handoff is needed here the
      // way rotate.ts needs one, since there's no coexistence window for the
      // old and new key to conflict during.
      await tx
        .update(apiKeys)
        .set({ revokedAt: new Date(), revokedBy: userId })
        .where(and(eq(apiKeys.id, target.id), eq(apiKeys.tenantId, tenantId)));

      if (liveSuccessor) {
        await tx
          .update(apiKeys)
          .set({ revokedAt: new Date(), revokedBy: userId })
          .where(
            and(
              eq(apiKeys.id, liveSuccessor.id),
              eq(apiKeys.tenantId, tenantId),
            ),
          );
      }

      await writeAuditEntry(tx, {
        tenantId,
        actorId: userId,
        actorType: "user",
        resourceId: target.id,
        resourceType: "api_key",
        action: "deleted",
        beforeSnapshot: { name: target.name, scopes: target.scopes },
        metadata: {
          emergencyRotate: true,
          replacedBy: created.id,
          liveSuccessorAlsoKilled: liveSuccessor?.id ?? null,
        },
      });
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
        metadata: { emergencyRotatedFrom: target.id },
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
