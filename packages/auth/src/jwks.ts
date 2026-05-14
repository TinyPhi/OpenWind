import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload, KeyLike } from "jose";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import type { ZitadelClaims } from "./types.js";

type JwksGetter = ReturnType<typeof createRemoteJWKSet>;

let _jwks: JwksGetter | undefined;

function getJwks(): JwksGetter {
  if (!_jwks) {
    const jwksUri = new URL(
      "/.well-known/openid-configuration/../oauth/v2/keys",
      env.ZITADEL_ISSUER,
    );
    // jose will re-fetch the key set when the kid is not found (key rotation)
    _jwks = createRemoteJWKSet(jwksUri);
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
        audience: env.ZITADEL_AUDIENCE,
      },
    );
    return payload as JWTPayload & ZitadelClaims;
  } catch (err) {
    logger.warn({ error: String(err) }, "JWT verification failed");
    return null;
  }
}

export function extractAuthContext(claims: JWTPayload & ZitadelClaims): {
  userId: string;
  tenantId: string;
  roles: string[];
  email: string;
} | null {
  const userId = claims.sub;
  const tenantId = claims["urn:zitadel:iam:org:id"];

  if (!userId || !tenantId) return null;

  // Flatten all role names across all projects
  const rolesMap = claims["urn:zitadel:iam:org:project:roles"] ?? {};
  const roles = Object.keys(rolesMap);

  return {
    userId,
    tenantId,
    roles,
    email: claims.email ?? "",
  };
}
