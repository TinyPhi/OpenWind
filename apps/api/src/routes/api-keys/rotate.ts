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
import { and, eq, gt, isNull, ne, or } from "drizzle-orm";
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
          rotatedFrom: apiKeys.rotatedFrom,
          applicationName: apiKeys.applicationName,
          applicationDescription: apiKeys.applicationDescription,
          applicationContactEmail: apiKeys.applicationContactEmail,
          oidcClientId: apiKeys.oidcClientId,
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
      // ADR-012 Phase A (PR A3): only applies to role-format (internal) keys
      // — action-format (third-party) keys are never gated by the creator's
      // own role ceiling, same as at mint time (create.ts), since action
      // scopes aren't role levels the ceiling can meaningfully compare
      // against. Previously this unconditionally rejected every action-format
      // scope string (ROLE_LEVEL has no entry for them, so scopeCeilingError
      // always failed closed), permanently 403ing rotation of every
      // third-party key — tracked as a TODO here since Round 5 (review
      // finding M2, PR #373); closed now that action-format keys actually
      // exist to rotate.
      if (original.scopesFormat === "role") {
        const scopeError = scopeCeilingError(roles, original.scopes);
        if (scopeError) return { error: "forbidden" as const, scopeError };
      }

      // Generated only once eligibility + scope checks pass — hashApiKeyArgon2
      // is intentionally slow (~100-250ms); doing this before the checks above
      // would burn a full argon2id computation on every invalid/cross-tenant
      // rotate attempt for no reason (review finding, PR #361).
      const rawKey = `sk_live_${randomBytes(32).toString("base64url")}`;
      const keyHash = hashApiKey(rawKey);
      const keyHashArgon2 = await hashApiKeyArgon2(rawKey);
      // ADR-012 Phase A spec R6: third-party (action-format) keys get the
      // same fixed 3-month expiry on rotation as at mint time — not the
      // internal-key default TTL, which previously applied unconditionally
      // here regardless of format.
      const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
      const expiresAt =
        original.scopesFormat === "action"
          ? new Date(Date.now() + THREE_MONTHS_MS)
          : new Date(
              Date.now() + API_KEY_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000,
            );
      const overlapExpiresAt = new Date(
        Date.now() + API_KEY_ROTATION_OVERLAP_HOURS * 60 * 60 * 1000,
      );

      // Dual-valid overlap window (ADR-008 Decision #3): the original stays
      // usable until overlapExpiresAt instead of being killed immediately, so
      // in-flight callers get a chance to pick up the replacement. It then
      // stops resolving on its own via the same expiry check every key goes
      // through (migration 0053) — no separate revoke step or scheduled job.
      // Only ever SHORTENS the original's expiresAt, never extends it — a key
      // already due to expire sooner than the overlap window keeps its
      // existing (sooner) expiry, so rotation can't accidentally resurrect a
      // credential for longer than it was already going to live.
      //
      // Run BEFORE the insert below, not after — Postgres checks unique
      // constraints immediately (not deferred), so if the successor's insert
      // ran first, both rows would briefly hold oidc_client_id_active =
      // true at once and the insert itself would fail the very index this
      // handoff exists to satisfy.
      const newExpiresAt =
        original.expiresAt !== null && original.expiresAt < overlapExpiresAt
          ? original.expiresAt
          : overlapExpiresAt;
      await tx
        .update(apiKeys)
        .set({
          expiresAt: newExpiresAt,
          // Migration 0069/0072: the dying predecessor keeps authenticating
          // (revoked_at untouched) and keeps its oidc_client_id *value*
          // (so it still identifies the right application if anything reads
          // it during the grace window), but hands off the Client ID's
          // uniqueness claim to the successor immediately — the successor
          // keeps the column's own default (true), so exactly one row is
          // ever the "holder" at a time. A no-op for role-format keys
          // (column stays at its default there regardless).
          oidcClientIdActive: false,
          // Migration 0087/0088 — same handoff, same reason, for
          // applicationName's own uniqueness claim: the predecessor keeps
          // its applicationName *value* (still identifies the right
          // application during the grace window) but hands off the
          // uniqueness claim to the successor immediately, so the insert
          // below doesn't collide with itself.
          applicationNameActive: false,
        })
        .where(
          and(eq(apiKeys.id, original.id), eq(apiKeys.tenantId, tenantId)),
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
          // The application record identifies WHICH external application
          // this key belongs to — that identity doesn't change on rotation,
          // only the credential itself does. Undefined (not carried) for
          // role-format keys, same as at mint time.
          ...(original.scopesFormat === "action"
            ? {
                applicationName: original.applicationName,
                applicationDescription: original.applicationDescription,
                applicationContactEmail: original.applicationContactEmail,
                oidcClientId: original.oidcClientId,
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
          oidcClientId: apiKeys.oidcClientId,
        });
      if (!created) {
        throw new Error("api_keys insert returned no row");
      }

      // ADR-012 Phase A spec R4: rotation lineage never exceeds 2 live nodes
      // (one dying, one active). Two ways an already-2-node lineage could
      // otherwise grow a 3rd live member when `original` is rotated again:
      //   (a) `original` itself has a live predecessor (original.rotatedFrom
      //       points at a row that's still dying, not yet revoked/expired) —
      //       rotating `original` again while that predecessor lingers would
      //       leave 3 live nodes: the old predecessor, `original` (now
      //       dying), and the new key (active).
      //   (b) `original` already has a live successor from an earlier
      //       rotation (some other row's rotatedFrom = original.id, still
      //       live) — calling rotate on `original` a second time before that
      //       successor's own grace naturally elapses would create a second,
      //       branching active key instead of the lineage's one true active
      //       member.
      // Both are closed the same way, in one query: instantly kill whichever
      // of the two exists (there can be at most one of each at a time, per
      // this same invariant already having been enforced on every prior
      // rotation) — "killed instantly, new key becomes sole active member of
      // the lineage" (spec R4), not left to finish its own grace/expiry.
      await tx
        .update(apiKeys)
        .set({
          revokedAt: new Date(),
          revokedBy: "system:rotation-lineage-cap",
        })
        .where(
          and(
            eq(apiKeys.tenantId, tenantId),
            isNull(apiKeys.revokedAt),
            ne(apiKeys.id, original.id),
            // The row just inserted above also has rotatedFrom = original.id
            // (that's how every successor is linked to its predecessor) —
            // without this exclusion this query catches and instantly
            // revokes the key it just created, on every single rotation,
            // not just the genuine multi-generation lineage-cap scenarios
            // this is meant for (found via manual testing: two consecutive
            // rotates both self-revoked their own new key within
            // milliseconds).
            ne(apiKeys.id, created.id),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
            or(
              ...[
                original.rotatedFrom
                  ? eq(apiKeys.id, original.rotatedFrom)
                  : undefined,
                eq(apiKeys.rotatedFrom, original.id),
              ].filter(
                (cond): cond is NonNullable<typeof cond> => cond !== undefined,
              ),
            ),
          ),
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
