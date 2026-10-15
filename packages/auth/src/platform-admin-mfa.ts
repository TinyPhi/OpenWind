import {
  randomBytes,
  randomInt,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { getRedis, withRedisTimeout } from "@platform/redis";
import { sendDirectNotification } from "@platform/notifications";
import { logger } from "@platform/logger";
import { env } from "@platform/config";

/**
 * OpenWind-owned MFA for the Multi-Org Sandbox System's platform_admin role
 * (docs/specs/multi-org-sandbox.md R1, ADR-022). Zitadel's own second-factor methods are not
 * usable on this hosted instance (no SMTP for OTP-by-email, no SMS gateway, and TOTP is not
 * offered at all on this instance/plan) -- found during implementation, not a design
 * preference. This replaces the originally-planned `amr`-claim check (packages/auth/src/
 * jwks.ts's hasMfaFactor, left in place but unused by requirePlatformAdmin -- see that
 * function's own comment) with a step OpenWind controls end-to-end: generate a code, email it
 * through the already-proven outbound-notification seam (packages/notifications'
 * sendDirectNotification), verify it, remember the verification for a while.
 *
 * Unlike checkRateLimit/withTenantContext's existing Redis usage, a Redis outage here must
 * FAIL CLOSED, not open -- "Redis is down" must never be indistinguishable from "this admin
 * completed MFA". isMfaVerified uses withRedisTimeout with `false` as the fallback specifically
 * so a timeout/error denies access rather than granting it; requestMfaCode/verifyMfaCode do
 * not use withRedisTimeout at all and let a Redis error propagate as a clear failure instead
 * of silently reporting success.
 *
 * Verification belongs to one sign-in, not to the account: a correct code returns a random
 * MFA session token, and the verified/fresh markers are keyed by the user id AND that token's
 * hash. The client drops the token on every completed sign-in and on sign-out, so each sign-in
 * needs its own code, and a second browser or device holding only the account's password (or
 * an access token) never inherits another session's verification.
 */

/** Request header carrying the MFA session token verifyMfaCode issued to this sign-in. */
export const PLATFORM_ADMIN_MFA_SESSION_HEADER = "X-Platform-Admin-Mfa";

export const MFA_CODE_TTL_SECONDS = 600; // 10 minutes to enter the code
const VERIFIED_TTL_SECONDS = 12 * 60 * 60; // a single sign-in's verification lasts at most 12h
const MAX_VERIFY_ATTEMPTS = 5; // guards the 6-digit code against brute force within its TTL

function otpKey(userId: string): string {
  return `platform-admin:mfa:otp:${userId}`;
}
function attemptsKey(userId: string): string {
  return `platform-admin:mfa:attempts:${userId}`;
}
function verifiedKey(userId: string, sessionToken: string): string {
  return `platform-admin:mfa:verified:${userId}:${sha256(sessionToken)}`;
}
function freshKey(userId: string, sessionToken: string): string {
  return `platform-admin:mfa:fresh:${userId}:${sha256(sessionToken)}`;
}
function resendKey(userId: string): string {
  return `platform-admin:mfa:resend:${userId}`;
}

/**
 * Thrown when a code is requested again before PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS has
 * passed. The route turns it into a 429 that tells the admin how long to wait.
 */
export class MfaResendTooSoonError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`A code was sent recently; retry in ${retryAfterSeconds}s`);
    this.name = "MfaResendTooSoonError";
  }
}

// Exactly what verifyMfaCode issues: 32 random bytes, base64url. Anything else in the header is
// treated as "no session" before it reaches Redis.
const SessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

function sessionTokenFrom(raw: string | undefined): string | undefined {
  const parsed = SessionTokenSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** "pat.smith@example.com" -> "p***@example.com" -- enough to recognise the inbox, not more. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export type MfaVerifyResult =
  | { ok: true; sessionToken: string }
  | { ok: false; reason: "invalid"; attemptsRemaining: number }
  | { ok: false; reason: "expired" | "locked" };

function generateCode(): string {
  // 6-digit, zero-padded -- randomInt's upper bound is exclusive.
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/**
 * Generates a fresh code, stores its hash (never the plaintext) with a TTL, resets the
 * attempt counter, and emails it via the direct outbound-notification path. Throws if the
 * email genuinely fails to send -- the caller (the /platform-admin/mfa/request route) must
 * tell the platform admin the code was not delivered, not report success for a dropped send.
 */
export async function requestMfaCode(
  userId: string,
  email: string,
): Promise<{ sentTo: string }> {
  const redis = getRedis();
  // Cooldown first, before a code is generated or stored: a refused resend must leave the
  // code the admin already has valid. NX so concurrent requests cannot both pass.
  const claimed = await redis.set(
    resendKey(userId),
    "1",
    "EX",
    env.PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS,
    "NX",
  );
  if (claimed === null) {
    // The wait comes from Redis, never from config: -2 (the key expired between the two calls)
    // and -1 (no expiry) both mean there is nothing left to wait for, so "retry in a second".
    const ttl = await redis.ttl(resendKey(userId));
    throw new MfaResendTooSoonError(ttl > 0 ? ttl : 1);
  }

  const code = generateCode();
  await redis.set(otpKey(userId), sha256(code), "EX", MFA_CODE_TTL_SECONDS);
  await redis.del(attemptsKey(userId));

  try {
    await sendDirectNotification({
      notificationId: `platform-admin-mfa:${userId}:${Date.now()}`,
      title: "Your OpenWind platform admin verification code",
      body: `Your verification code is ${code}. It expires in 10 minutes. If you did not request this, contact your OpenWind administrator.`,
      recipients: [{ userId, email }],
    });
  } catch (err) {
    // The code never reached the admin, so the cooldown must not make them wait to retry a
    // failure that was not theirs.
    await redis.del(resendKey(userId));
    throw err;
  }

  const sentTo = maskEmail(email);
  logger.info({ userId, sentTo }, "platform-admin-mfa: code sent");
  return { sentTo };
}

/**
 * Verifies a submitted code against the stored hash. A correct code consumes it (deletes the
 * otp/attempts keys), ends the session token the client presented (a step-up replaces it), and
 * starts a new MFA session. An incorrect code increments the attempt counter; the last allowed
 * wrong guess invalidates the code outright (the admin must request a new one) rather than
 * allowing unlimited guesses within the 10-minute window.
 */
export async function verifyMfaCode(
  userId: string,
  submittedCode: string,
  previousSessionToken?: string,
): Promise<MfaVerifyResult> {
  const redis = getRedis();
  const storedHash = await redis.get(otpKey(userId));
  if (!storedHash) return { ok: false, reason: "expired" };

  // Review finding (PR #803): INCR is atomic so concurrent calls always get distinct,
  // strictly-increasing counts -- no two requests can ever read the same attempt number.
  // The remaining (accepted) slack is timing, not a shared counter race: several concurrent
  // guesses can each observe a count <= MAX_VERIFY_ATTEMPTS and reach the comparison below
  // before any of them has deleted the code, so a burst of truly simultaneous requests can
  // land marginally more than MAX_VERIFY_ATTEMPTS comparisons before lockout takes effect.
  // For a 6-digit numeric OTP this does not materially change the brute-force odds (roughly
  // 2x MAX_VERIFY_ATTEMPTS guesses worst-case out of 1,000,000 is still ~0.001%), and this is
  // a single-trusted-operator role (spec §C), so a Lua-script atomic increment-check-compare
  // is not worth the added complexity here.
  const attempts = await redis.incr(attemptsKey(userId));
  if (attempts === 1) {
    await redis.expire(attemptsKey(userId), MFA_CODE_TTL_SECONDS);
  }
  // On lockout only the code is deleted. The attempts counter stays until it expires, so a burst
  // of parallel guesses that already read the code still lands over the limit instead of
  // restarting the count at 1.
  if (attempts > MAX_VERIFY_ATTEMPTS) {
    await redis.del(otpKey(userId));
    logger.warn({ userId }, "platform-admin-mfa: max verify attempts exceeded");
    return { ok: false, reason: "locked" };
  }

  // Constant-time comparison -- both are sha256 hex digests, always 64 bytes, so this never
  // takes the length-mismatch branch in practice; timingSafeEqual still requires equal-length
  // buffers, hence the explicit check first.
  const submittedHash = Buffer.from(sha256(submittedCode));
  const storedHashBuf = Buffer.from(storedHash);
  if (
    submittedHash.length !== storedHashBuf.length ||
    !timingSafeEqual(submittedHash, storedHashBuf)
  ) {
    const attemptsRemaining = MAX_VERIFY_ATTEMPTS - attempts;
    if (attemptsRemaining <= 0) {
      await redis.del(otpKey(userId));
      logger.warn(
        { userId },
        "platform-admin-mfa: max verify attempts exceeded",
      );
      return { ok: false, reason: "locked" };
    }
    return { ok: false, reason: "invalid", attemptsRemaining };
  }

  await redis.del(otpKey(userId), attemptsKey(userId));
  await endMfaSession(userId, previousSessionToken);
  const sessionToken = randomBytes(32).toString("base64url");
  await redis.set(
    verifiedKey(userId, sessionToken),
    "1",
    "EX",
    VERIFIED_TTL_SECONDS,
  );
  // Step-up marker (ADR-022 Decision 10, #865): this code was just entered, so the admin is
  // "fresh" for the configured window -- what reset and delete require on top of the
  // 12-hour verified flag.
  await redis.set(
    freshKey(userId, sessionToken),
    "1",
    "EX",
    env.PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS,
  );
  logger.info({ userId }, "platform-admin-mfa: verified");
  return { ok: true, sessionToken };
}

/** Sign-out: this session's verification ends now instead of when its markers expire. */
export async function endMfaSession(
  userId: string,
  rawSessionToken: string | undefined,
): Promise<void> {
  const sessionToken = sessionTokenFrom(rawSessionToken);
  if (!sessionToken) return;
  await getRedis().del(
    verifiedKey(userId, sessionToken),
    freshKey(userId, sessionToken),
  );
}

/**
 * Fails closed: a Redis timeout/error denies access, never grants it. No session token (a
 * request from a browser that never entered a code) is never verified.
 */
export async function isMfaVerified(
  userId: string,
  rawSessionToken: string | undefined,
): Promise<boolean> {
  const sessionToken = sessionTokenFrom(rawSessionToken);
  if (!sessionToken) return false;
  return withRedisTimeout(
    async () =>
      (await getRedis().get(verifiedKey(userId, sessionToken))) !== null,
    false,
    { userId, op: "platform-admin-mfa:isMfaVerified" },
  );
}

/**
 * True only if a code was verified within PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS. Fails
 * closed like isMfaVerified: a Redis timeout/error is "not fresh", never "fresh".
 */
export async function isMfaFresh(
  userId: string,
  rawSessionToken: string | undefined,
): Promise<boolean> {
  const sessionToken = sessionTokenFrom(rawSessionToken);
  if (!sessionToken) return false;
  return withRedisTimeout(
    async () => (await getRedis().get(freshKey(userId, sessionToken))) !== null,
    false,
    { userId, op: "platform-admin-mfa:isMfaFresh" },
  );
}
