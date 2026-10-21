import { z } from "zod";
import type { Context } from "hono";
import { zValidator } from "../../lib/validator.js";
import {
  requirePlatformAdminIdentity,
  requestMfaCode,
  verifyMfaCode,
  endMfaSession,
  MfaResendTooSoonError,
  MfaLockedOutError,
  PLATFORM_ADMIN_MFA_SESSION_HEADER,
} from "@platform/auth";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import { platformAdminFactory } from "./factory.js";

/**
 * Mounted with requirePlatformAdminIdentity (role claim only, no MFA check) -- these are the
 * routes that must be reachable BEFORE MFA is verified, since requirePlatformAdmin would
 * otherwise make verifying MFA itself unreachable. See packages/auth/src/middleware.ts's
 * requirePlatformAdminIdentity doc comment.
 *
 * No route-local rate limit here beyond the global per-IP rateLimit() mounted on `*`
 * (apps/api/src/app.ts) -- security.md's 10 req/min guidance for auth endpoints is already
 * matched by platform-admin-mfa.ts's own caps: MAX_VERIFY_ATTEMPTS=5 per code within its
 * 10-minute TTL, and MAX_FAILED_VERIFIES=5 per admin within 30 minutes across resends (which a
 * new code doesn't reset). These are the more meaningful bound for these routes (a per-IP limit
 * alone wouldn't stop repeated guesses from different IPs against one admin's code; the
 * per-admin caps do). Independent layers, not a gap.
 */
/**
 * Too many incorrect codes across resends (PR #947 R3 finding 1): no code is sent and none is
 * verified until the window ends. 429 with Retry-After, like the resend cooldown.
 */
function lockedOutResponse(c: Context, retryAfterSeconds: number): Response {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  c.header("Retry-After", String(retryAfterSeconds));
  return c.json(
    {
      error: "TOO_MANY_ATTEMPTS",
      message: `Too many incorrect codes. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
      meta: { retryAfterSeconds },
    },
    429,
  );
}

export const mfaRequestHandler = platformAdminFactory.createHandlers(
  requirePlatformAdminIdentity(),
  async (c) => {
    const { userId, email } = c.get("platformAdmin");
    if (!email) {
      return c.json(
        { error: "NO_EMAIL", message: "No email on file for this account" },
        422,
      );
    }
    let sentTo: string;
    try {
      ({ sentTo } = await requestMfaCode(userId, email));
    } catch (err) {
      if (err instanceof MfaLockedOutError) {
        return lockedOutResponse(c, err.retryAfterSeconds);
      }
      if (err instanceof MfaResendTooSoonError) {
        c.header("Retry-After", String(err.retryAfterSeconds));
        return c.json(
          {
            error: "MFA_RESEND_TOO_SOON",
            message: `A code was sent recently. Try again in ${err.retryAfterSeconds} seconds.`,
            meta: { retryAfterSeconds: err.retryAfterSeconds },
          },
          429,
        );
      }
      logger.error({ err, userId }, "platform-admin mfa/request: send failed");
      return c.json(
        { error: "SEND_FAILED", message: "Could not send verification code" },
        502,
      );
    }
    return c.json({
      data: {
        sent: true,
        // Masked ("p***@example.com"): enough for the admin to know which inbox to check.
        sentTo,
        // Lets the client run an accurate resend countdown from the server's own setting.
        resendAfterSeconds: env.PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS,
        expiresInSeconds: env.PLATFORM_ADMIN_MFA_CODE_TTL_SECONDS,
      },
    });
  },
);

// Review finding (PR #804): length(6) alone let non-numeric strings through, each wasting an
// attempt against verifyMfaCode's lockout cap even though they can never hash-match a real code.
const VerifyMfaSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

// 422, not 401: a wrong code is not an expired sign-in. The client refreshes its token and
// replays a request on 401, which would spend a second verification attempt on the same code.
const VERIFY_FAILURES = {
  invalid: { error: "INVALID_CODE", message: "That code is incorrect." },
  expired: {
    error: "CODE_EXPIRED",
    message: "This code has expired or was already used. Request a new one.",
  },
  locked: {
    error: "TOO_MANY_ATTEMPTS",
    message: "Too many incorrect attempts. Request a new code.",
  },
} as const;

export const mfaVerifyHandler = platformAdminFactory.createHandlers(
  requirePlatformAdminIdentity(),
  zValidator("json", VerifyMfaSchema),
  async (c) => {
    const { userId } = c.get("platformAdmin");
    const { code } = c.req.valid("json");
    const result = await verifyMfaCode(
      userId,
      code,
      c.req.header(PLATFORM_ADMIN_MFA_SESSION_HEADER),
    );
    if (!result.ok) {
      if (result.reason === "locked_out") {
        return lockedOutResponse(c, result.retryAfterSeconds);
      }
      return c.json(
        {
          ...VERIFY_FAILURES[result.reason],
          ...(result.reason === "invalid"
            ? { meta: { attemptsRemaining: result.attemptsRemaining } }
            : {}),
        },
        422,
      );
    }
    return c.json({
      data: { verified: true, sessionToken: result.sessionToken },
    });
  },
);

/**
 * Sign-out: ends the presented sign-in's MFA session at once rather than leaving it to expire.
 * Identity-only like the two above, so it still works for a session that was never verified.
 */
export const mfaEndHandler = platformAdminFactory.createHandlers(
  requirePlatformAdminIdentity(),
  async (c) => {
    const { userId } = c.get("platformAdmin");
    await endMfaSession(
      userId,
      c.req.header(PLATFORM_ADMIN_MFA_SESSION_HEADER),
    );
    return c.body(null, 204);
  },
);
