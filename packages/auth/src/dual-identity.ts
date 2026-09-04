import { createMiddleware } from "hono/factory";
import { and, eq, isNull } from "drizzle-orm";
import type { Context, Next, MiddlewareHandler } from "hono";
import { apiKeys, withTenantContext } from "@platform/db";
import { logger } from "@platform/logger";
import { verifyJwtWithAudience, verifyJwtForIssuer } from "./jwks.js";
import type { AuthContext } from "./types.js";

/**
 * ADR-012 Phase B — the acting-person identity carried alongside a
 * third-party API key on every ticket-lifecycle request. Distinct from
 * AuthContext (which represents the key/session identity) because a
 * single API key is reused across many different acting people over its
 * lifetime — this is per-request, never cached against the key.
 */
export interface ActingPersonContext {
  userId: string;
  email: string;
  displayName: string;
  orgId: string | undefined;
}

type ActingPersonVariables = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

const ACTING_PERSON_TOKEN_HEADER = "X-Acting-Person-Token";

// ADR-012 Phase B, spec R3 / design doc Round 4 NEW-04: independent of
// whatever lifetime Zitadel itself is configured with for this token — an
// operator silently lengthening that setting later must not widen this
// window. A named constant (not an env var) because this is a security
// invariant of the design, not an operationally-tunable knob — same
// precedent as API_KEY_ROTATION_OVERLAP_HOURS in middleware.ts.
export const ACTING_PERSON_TOKEN_MAX_AGE_MINUTES = 15;

// Third-party API key external-org mapping (docs/specs/third-party-key-external-org-mapping.md,
// Phase 1 T3) -- different IdPs put the org id under different claim names
// (Zitadel: "urn:zitadel:iam:user:resourceowner:id"; AuthNexus: "org_id").
// Checked in priority order rather than branching on issuer/provider name,
// so this works for a new IdP by adding its claim name here, not by adding
// a new hardcoded provider-detection branch throughout this file. Zitadel's
// claim is checked first so the existing single-IdP path's behavior is
// unchanged when only that claim is present.
const ORG_CLAIM_NAMES = [
  "urn:zitadel:iam:user:resourceowner:id",
  "org_id",
] as const;

function extractOrgClaim(claims: Record<string, unknown>): string | undefined {
  for (const name of ORG_CLAIM_NAMES) {
    const value = claims[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

// docs/specs/third-party-key-external-org-mapping.md Phase 2 T6, per the
// security review of Phase 1 (spec §B B3): a key with an external_issuer
// mapping must resolve the org-claim NAME for that SPECIFIC issuer, not
// fall through the flat priority list above. The flat list is safe only
// when every token verified comes from the platform's single trusted
// issuer (today's default path, left unchanged below) -- once a second
// real issuer is in play, a malicious/compromised external IdP could
// include a Zitadel-shaped claim in its own token and have it win over the
// correct one. Exact-match by issuer string, not a substring/heuristic
// match, and no fallback to the flat list.
//
// There is deliberately no admin-configurable claim-name field yet (out of
// scope for this spec, per the plan-lock's scope_paths) -- unrecognized
// external issuers default to "org_id" (the common modern-OIDC convention
// this platform has seen from AuthNexus), which is a reasonable default,
// not a guarantee. An issuer using something else needs an entry added
// here explicitly. PR #545 review (PrabhuVijit, SUGGESTION) -- notably,
// ANY secondary Zitadel instance used as an external issuer would silently
// 401 under this default, since Zitadel itself uses the namespaced
// `urn:zitadel:iam:user:resourceowner:id` claim, not `org_id` (see
// dual-identity.test.ts's "rejects a Zitadel-namespaced org claim on the
// external path" case). Tracked in issue #549 -- populate entries here
// when a second Zitadel-backed customer or another non-AuthNexus IdP using
// a namespaced org claim is onboarded, adding its entry here rather than
// widening the default.
const ORG_CLAIM_NAME_BY_EXTERNAL_ISSUER: Record<string, string> = {};
const DEFAULT_EXTERNAL_ORG_CLAIM_NAME = "org_id";

function extractOrgClaimForExternalIssuer(
  claims: Record<string, unknown>,
  issuer: string,
): string | undefined {
  const claimName =
    ORG_CLAIM_NAME_BY_EXTERNAL_ISSUER[issuer] ??
    DEFAULT_EXTERNAL_ORG_CLAIM_NAME;
  const value = claims[claimName];
  return typeof value === "string" && value ? value : undefined;
}

function unauthorized(c: Context): Response {
  // Deliberately generic across every failure case below (missing header,
  // malformed token, aud mismatch, stale iat, tenant/org mismatch, key with
  // no registered Client ID) — spec R14: none of these are distinguishable
  // to the caller, matching the same principle already applied to
  // bad/expired/revoked API keys.
  return c.json({ error: "UNAUTHORIZED", message: "Invalid token" }, 401);
}

/**
 * requireActingPerson — verifies the second identity ADR-012 Phase B
 * requires on every third-party ticket-lifecycle request: a real person,
 * proven via a signed Zitadel token, distinct from the API key itself.
 *
 * Must run AFTER requireAuth(db) so that c.get("auth") is already
 * populated. Only meaningful on the API-key auth path — requireAuth's JWT
 * (human session) path has no separate "acting person" to verify, since the
 * session's own subject already IS the acting person.
 */
export const requireActingPerson = (): MiddlewareHandler =>
  createMiddleware<ActingPersonVariables>(
    async (
      c: Context<ActingPersonVariables>,
      next: Next,
    ): Promise<Response | void> => {
      // Short-circuit when actingPerson has been pre-populated (test
      // fixtures) — same precedent as requireAuth's own early-return in
      // middleware.ts. Hono's Variables type marks it as always-present
      // after this middleware runs, but here we ARE the setter — at call
      // time it may genuinely be absent.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (c.get("actingPerson")) {
        await next();
        return;
      }

      const auth = c.get("auth");

      // requireAuth sets userId to `apikey:<id>` on the API-key path
      // (middleware.ts resolveApiKey) and to the real Zitadel subject on the
      // JWT path — this is the only reliable structural signal available to
      // tell the two apart without adding a new AuthContext field.
      const apiKeyMatch = /^apikey:(.+)$/.exec(auth.userId);
      const apiKeyId = apiKeyMatch?.[1];
      if (!apiKeyId) {
        return unauthorized(c);
      }

      const personToken = c.req.header(ACTING_PERSON_TOKEN_HEADER);
      if (!personToken) {
        return unauthorized(c);
      }

      // Only a third-party key (one minted with a registered Client ID, per
      // Phase A) is eligible for dual-identity verification — there is
      // nothing valid to check `aud` against otherwise, and treating that
      // as a generic unauthorized (rather than a distinct error) avoids
      // revealing which case applied.
      const [keyRow] = await withTenantContext(auth.tenantId, (tx) =>
        tx
          .select({
            oidcClientId: apiKeys.oidcClientId,
            externalIssuer: apiKeys.externalIssuer,
            externalOrgId: apiKeys.externalOrgId,
          })
          .from(apiKeys)
          .where(and(eq(apiKeys.id, apiKeyId), isNull(apiKeys.revokedAt)))
          .limit(1),
      );
      if (!keyRow?.oidcClientId) {
        return unauthorized(c);
      }

      // docs/specs/third-party-key-external-org-mapping.md R3/T6: a key
      // with an external mapping verifies against THAT issuer's JWKS (via
      // discovery, Phase 1's verifyJwtForIssuer) instead of the platform's
      // single hardcoded ZITADEL_ISSUER -- create.ts's validation (T5)
      // already guarantees externalIssuer/externalOrgId are set together
      // or not at all, so checking one implies the other here.
      const claims = keyRow.externalIssuer
        ? await verifyJwtForIssuer(
            personToken,
            keyRow.externalIssuer,
            keyRow.oidcClientId,
            auth.tenantId,
          )
        : await verifyJwtWithAudience(personToken, keyRow.oidcClientId);
      if (!claims) {
        return unauthorized(c);
      }

      // Freshness check independent of Zitadel's own configured token
      // lifetime (spec R3) — a token otherwise perfectly valid but minted
      // too long ago is rejected here, not relied upon via `exp` alone.
      const issuedAt = claims.iat;
      if (typeof issuedAt !== "number") {
        return unauthorized(c);
      }
      const ageSeconds = Date.now() / 1000 - issuedAt;
      if (
        ageSeconds > ACTING_PERSON_TOKEN_MAX_AGE_MINUTES * 60 ||
        ageSeconds < -60
      ) {
        return unauthorized(c);
      }

      // Tenant/org match gate — a structurally valid, correctly-audienced,
      // fresh token from a *different* tenant/org than the presented key's
      // own tenant is still rejected (spec R4). auth.orgId is the tenant's
      // mapped Zitadel org, already resolved by requireAuth's API-key path.
      // R3/T6: a key with an external mapping compares against ITS OWN
      // external_org_id instead, using the per-issuer claim-name lookup
      // (not the flat priority list) since a second real issuer is now in
      // play — see extractOrgClaimForExternalIssuer's own comment.
      const expectedOrgId = keyRow.externalIssuer
        ? keyRow.externalOrgId
        : auth.orgId;
      const tokenOrgId = keyRow.externalIssuer
        ? extractOrgClaimForExternalIssuer(claims, keyRow.externalIssuer)
        : extractOrgClaim(claims);
      if (!tokenOrgId || tokenOrgId !== expectedOrgId) {
        // Deliberately omits apiKeyId/tokenOrgId from this log line — the
        // API key's own audit trail (create/rotate/revoke) already records
        // the specific key involved elsewhere; tenantId alone is enough to
        // triage a mismatch here without logging identifiers CodeQL's
        // clear-text-logging query treats as sensitive.
        logger.warn(
          { tenantId: auth.tenantId },
          "acting-person token org does not match the presented key's tenant",
        );
        return unauthorized(c);
      }

      const userId = claims.sub;
      if (!userId) {
        return unauthorized(c);
      }

      const displayName =
        claims.name ??
        ([claims.given_name, claims.family_name].filter(Boolean).join(" ") ||
          null) ??
        claims.email ??
        userId;

      c.set("actingPerson", {
        userId,
        email: claims.email ?? "",
        displayName,
        orgId: tokenOrgId,
      });

      await next();
      return;
    },
  );
