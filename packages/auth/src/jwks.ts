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
        // Skip audience validation unless ZITADEL_AUDIENCE is explicitly set to the project ID.
        // Signature + issuer verification is the primary security guard.
        ...(env.ZITADEL_AUDIENCE ? { audience: env.ZITADEL_AUDIENCE } : {}),
      },
    );
    return payload as JWTPayload & ZitadelClaims;
  } catch (err) {
    logger.warn(
      {
        error: String(err),
        issuer: env.ZITADEL_ISSUER,
        audience: env.ZITADEL_AUDIENCE || "(not set)",
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
  const orgId = claims["urn:zitadel:iam:org:id"];

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
