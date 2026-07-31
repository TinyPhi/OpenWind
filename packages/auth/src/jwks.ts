import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload, KeyLike } from "jose";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import type { ZitadelClaims, AuthContext } from "./types.js";

type JwksGetter = ReturnType<typeof createRemoteJWKSet>;

let _jwks: JwksGetter | undefined;

function getJwks(): JwksGetter {
  if (!_jwks) {
    // ZITADEL_JWKS_URL lets the API container fetch keys via the Docker-internal
    // hostname (e.g. http://zitadel:8080) while still validating the iss claim
    // against ZITADEL_ISSUER (http://localhost:8080 as seen by the browser).
    const jwksUri = new URL(
      (env.ZITADEL_JWKS_URL ?? `${env.ZITADEL_ISSUER}/oauth/v2/keys`) as string,
    );
    // Zitadel routes by Host header — provide a custom fetcher that sets Host
    // to match EXTERNALDOMAIN even when connecting via internal Docker hostname.
    const issuerHost = new URL(env.ZITADEL_ISSUER).hostname;
    const hostOverride =
      jwksUri.hostname !== issuerHost ? issuerHost : undefined;
    _jwks = createRemoteJWKSet(jwksUri, {
      // Refresh cached JWKS after 1 hour so a rotated/revoked signing key stops
      // being accepted within a bounded window. Without this the cache is
      // infinite and key rotation requires a process restart. (#262)
      cacheMaxAge: 60 * 60 * 1000,
      ...(hostOverride !== undefined
        ? {
            headers: { Host: hostOverride },
          }
        : {}),
    });
  }
  return _jwks;
}

export async function verifyJwt(
  token: string,
): Promise<(JWTPayload & ZitadelClaims) | null> {
  try {
    const { payload } = await jwtVerify(
      token,
      getJwks() as unknown as KeyLike,
      {
        issuer: env.ZITADEL_ISSUER,
        // Zitadel puts the PROJECT ID in aud, not the OIDC client ID.
        // ZITADEL_AUDIENCE is required and non-empty (packages/config/src/env.ts),
        // so audience validation is always enforced here.
        audience: env.ZITADEL_AUDIENCE,
        // 5 s is sufficient to absorb NTP clock skew between containers.
        // 30 s was wider than necessary and extended the replay window for
        // stolen tokens by 25 extra seconds past their stated expiry. (#255)
        clockTolerance: 5,
      },
    );
    return payload as JWTPayload & ZitadelClaims;
  } catch (err) {
    logger.warn(
      {
        error: String(err),
        issuer: env.ZITADEL_ISSUER,
        audience: env.ZITADEL_AUDIENCE,
      },
      "JWT verification failed",
    );
    return null;
  }
}

export function extractAuthContext(
  claims: JWTPayload & ZitadelClaims,
): AuthContext | null {
  const userId = claims.sub;
  const orgId = claims["urn:zitadel:iam:user:resourceowner:id"];

  // In dev, always use DEV_TENANT_ID so all users (admin + org members) hit
  // the same seeded tenant. Zitadel org UUIDs in the JWT would otherwise map
  // to non-existent tenants and return empty data for portal users.
  const tenantId =
    env.NODE_ENV !== "production" ? (env.DEV_TENANT_ID ?? orgId) : orgId;

  if (!userId || !tenantId) return null;

  // Flatten all role names across all projects
  const rolesMap = claims["urn:zitadel:iam:org:project:roles"] ?? {};
  const roles = Object.keys(rolesMap);

  const displayName =
    claims.name ??
    ([claims.given_name, claims.family_name].filter(Boolean).join(" ") ||
      null) ??
    claims.email ??
    userId;

  return {
    userId,
    tenantId,
    roles,
    email: claims.email ?? "",
    displayName,
    orgId,
  };
}
