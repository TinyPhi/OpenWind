import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { env } from "@platform/config";
import { logger } from "@platform/logger";

// Mints an M2M access token for the dedicated `novu-outbound-caller` Zitadel
// machine user — completely separate from packages/auth/src/zitadel-management.ts's
// getAccessToken (which authenticates as openwind-api-bot for Zitadel's own
// management API). Kept as its own isolated module, own cache, own key —
// nothing here touches the existing management-API auth flow. This is the
// one seam docs/notification-outbound-contract.md's auth section describes;
// only this file needs to change if the outbound service's auth requirement
// ever changes.

const ServiceAccountKeySchema = z.object({
  type: z.string(),
  keyId: z.string(),
  key: z.string(),
  userId: z.string(),
  expirationDate: z.string().optional(),
});

let _cachedToken: string | null = null;
let _tokenExpiresAt = 0;

function parseKey(): z.infer<typeof ServiceAccountKeySchema> | null {
  const raw = env.NOTIFICATION_ZITADEL_KEY_JSON;
  if (!raw) return null;
  try {
    return ServiceAccountKeySchema.parse(JSON.parse(raw));
  } catch {
    logger.error(
      {},
      "notification-outbound-auth: NOTIFICATION_ZITADEL_KEY_JSON is not valid service-account JSON",
    );
    return null;
  }
}

/**
 * Returns a cached-or-fresh bearer token scoped to the outbound service's
 * expected audience (NOTIFICATION_ZITADEL_AUDIENCE), or null if the
 * dedicated key/audience aren't configured — callers must handle that by
 * dispatching without an Authorization header (the outbound service will
 * reject it, which flows through the existing retry/system.error path).
 */
export async function getNotificationOutboundToken(): Promise<string | null> {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt - 30_000) return _cachedToken;

  const keyConfig = parseKey();
  const audience = env.NOTIFICATION_ZITADEL_AUDIENCE;
  if (!keyConfig || !audience) return null;

  try {
    // Zitadel may return PKCS#1 ("BEGIN RSA PRIVATE KEY") or PKCS#8 ("BEGIN
    // PRIVATE KEY") — importPKCS8 only handles PKCS#8, so normalise via
    // Node's createPrivateKey, which accepts both.
    const exportedKey = keyConfig.key.includes("BEGIN PRIVATE KEY")
      ? keyConfig.key
      : createPrivateKey(keyConfig.key).export({
          type: "pkcs8",
          format: "pem",
        });
    const keyPem =
      typeof exportedKey === "string"
        ? exportedKey
        : (exportedKey as Buffer).toString("utf8");

    const privateKey = await importPKCS8(keyPem, "RS256");
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: keyConfig.keyId })
      .setIssuedAt()
      .setIssuer(keyConfig.userId)
      .setSubject(keyConfig.userId)
      .setAudience(env.ZITADEL_ISSUER)
      .setExpirationTime("1h")
      .sign(privateKey);

    const tokenUrl = `${env.ZITADEL_ISSUER}/oauth/v2/token`;
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope: `openid urn:zitadel:iam:org:project:id:${audience}:aud`,
        assertion,
      }).toString(),
    });

    if (!res.ok) {
      // Never log the raw response body — unvetted external payload.
      logger.error(
        { status: res.status },
        "notification-outbound-auth: token exchange failed",
      );
      return null;
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    _cachedToken = data.access_token;
    _tokenExpiresAt = now + data.expires_in * 1000;
    return _cachedToken;
  } catch (err) {
    logger.error({ err }, "notification-outbound-auth: failed to obtain token");
    return null;
  }
}
