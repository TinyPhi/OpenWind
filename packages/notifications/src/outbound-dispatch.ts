import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { env } from "@platform/config";
import { logger } from "@platform/logger";

/**
 * Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md R1, ADR-022). A tenant-INDEPENDENT
 * path to the same externally-owned outbound notification service apps/worker/src/
 * notification-outbound-worker.ts already uses for every tenant-scoped notification. That
 * worker's own dispatch function is NOT reused here -- it is built entirely around
 * `notifications`/`notificationRecipients` DB rows and a tenantId, neither of which exist for
 * a platform_admin request (cross-tenant by design). This file duplicates only the small,
 * already-proven "mint a token, POST to NOTIFICATION_SERVICE_URL" seam, for exactly one new
 * caller: the platform-admin MFA email-code flow (packages/auth's platform-admin-mfa.ts).
 * apps/worker's existing pipeline is intentionally left untouched -- it is well-tested,
 * production code outside this feature's scope.
 *
 * Reuses the same NOTIFICATION_ZITADEL_KEY_JSON/NOTIFICATION_ZITADEL_AUDIENCE/
 * NOTIFICATION_SERVICE_URL config the worker's copy reads -- same external service, same
 * credential, just a second, independent code path to it.
 */

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
      "outbound-dispatch: NOTIFICATION_ZITADEL_KEY_JSON is not valid service-account JSON",
    );
    return null;
  }
}

async function getDirectOutboundToken(): Promise<string | null> {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt - 30_000) return _cachedToken;

  const keyConfig = parseKey();
  const audience = env.NOTIFICATION_ZITADEL_AUDIENCE;
  if (!keyConfig || !audience) return null;

  try {
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

    const res = await fetch(`${env.ZITADEL_ISSUER}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope: `openid urn:zitadel:iam:org:project:id:${audience}:aud`,
        assertion,
      }).toString(),
    });

    if (!res.ok) {
      logger.error(
        { status: res.status },
        "outbound-dispatch: token exchange failed",
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
    logger.error({ err }, "outbound-dispatch: failed to obtain token");
    return null;
  }
}

export interface DirectNotificationPayload {
  notificationId: string;
  title: string;
  body: string;
  recipients: Array<{ userId: string; email: string | null }>;
}

/**
 * Sends one notification directly, synchronously, with no DB row and no BullMQ queue --
 * appropriate for a login-blocking OTP email, which needs to go out immediately and has no
 * tenant to anchor a queued/retried job to. Throws on a non-2xx response so the caller (the
 * MFA request route) can tell the platform admin the email genuinely failed to send, rather
 * than reporting success for a silently-dropped code.
 *
 * `tenantId` is deliberately omitted from the payload, unlike the worker's tenant-scoped
 * OutboundPayload shape -- the external service's exact contract for a tenant-less call is
 * unverified (same "contract unresolved" caveat the worker's own dispatch function already
 * carries), so a rejection here surfaces as a thrown error, not a silent no-op.
 */
export async function sendDirectNotification(
  payload: DirectNotificationPayload,
): Promise<void> {
  if (!env.NOTIFICATION_SERVICE_URL) {
    throw new Error(
      "outbound-dispatch: NOTIFICATION_SERVICE_URL not configured",
    );
  }

  const token = await getDirectOutboundToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  } else {
    logger.warn(
      { notificationId: payload.notificationId },
      "outbound-dispatch: dispatching without an auth token",
    );
  }

  const res = await fetch(env.NOTIFICATION_SERVICE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...payload,
      link: "",
      channels: { email: true, sms: false, whatsapp: false },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    // Review finding (PR #803): a 401 here means the cached token is no longer accepted
    // (rotated/revoked on the Novu side) -- without clearing it, every call for the rest of
    // this token's cached lifetime would keep sending the same stale, already-rejected
    // token instead of re-fetching a fresh one on the next call.
    if (res.status === 401) {
      _cachedToken = null;
      _tokenExpiresAt = 0;
    }
    logger.error(
      { status: res.status, body: bodyText },
      "outbound-dispatch: non-2xx response",
    );
    throw new Error(`Outbound service responded ${res.status}`);
  }
}
