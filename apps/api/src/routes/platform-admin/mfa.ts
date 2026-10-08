import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import {
  requirePlatformAdminIdentity,
  requestMfaCode,
  verifyMfaCode,
} from "@platform/auth";
import { logger } from "@platform/logger";
import { platformAdminFactory } from "./factory.js";

/**
 * Mounted with requirePlatformAdminIdentity (role claim only, no MFA check) -- these are the
 * two routes that must be reachable BEFORE MFA is verified, since requirePlatformAdmin would
 * otherwise make verifying MFA itself unreachable. See packages/auth/src/middleware.ts's
 * requirePlatformAdminIdentity doc comment.
 *
 * No route-local rate limit here beyond the global per-IP rateLimit() mounted on `*`
 * (apps/api/src/app.ts) -- security.md's 10 req/min guidance for auth endpoints is already
 * matched by platform-admin-mfa.ts's own MAX_VERIFY_ATTEMPTS=5-within-the-code's-10-minute-TTL
 * cap on /mfa/verify, which is the more meaningful bound for this specific route (a per-IP
 * limit alone wouldn't stop repeated guesses from different IPs against one admin's code; the
 * attempt cap does). Two independent layers, not a gap.
 */
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
    try {
      await requestMfaCode(userId, email);
    } catch (err) {
      logger.error({ err, userId }, "platform-admin mfa/request: send failed");
      return c.json(
        { error: "SEND_FAILED", message: "Could not send verification code" },
        502,
      );
    }
    return c.json({ data: { sent: true } });
  },
);

const VerifyMfaSchema = z.object({ code: z.string().length(6) });

export const mfaVerifyHandler = platformAdminFactory.createHandlers(
  requirePlatformAdminIdentity(),
  zValidator("json", VerifyMfaSchema),
  async (c) => {
    const { userId } = c.get("platformAdmin");
    const { code } = c.req.valid("json");
    const verified = await verifyMfaCode(userId, code);
    if (!verified) {
      return c.json(
        { error: "INVALID_CODE", message: "Incorrect or expired code" },
        401,
      );
    }
    return c.json({ data: { verified: true } });
  },
);
