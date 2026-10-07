import { randomInt, createHash, timingSafeEqual } from "node:crypto";
import { getRedis, withRedisTimeout } from "@platform/redis";
import { sendDirectNotification } from "@platform/notifications";
import { logger } from "@platform/logger";

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
 */

const OTP_TTL_SECONDS = 600; // 10 minutes to enter the code
const VERIFIED_TTL_SECONDS = 12 * 60 * 60; // re-prompt for a fresh code after 12h
const MAX_VERIFY_ATTEMPTS = 5; // guards the 6-digit code against brute force within its TTL

function otpKey(userId: string): string {
  return `platform-admin:mfa:otp:${userId}`;
}
function attemptsKey(userId: string): string {
  return `platform-admin:mfa:attempts:${userId}`;
}
function verifiedKey(userId: string): string {
  return `platform-admin:mfa:verified:${userId}`;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

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
): Promise<void> {
  const code = generateCode();
  const redis = getRedis();
  await redis.set(otpKey(userId), hashCode(code), "EX", OTP_TTL_SECONDS);
  await redis.del(attemptsKey(userId));

  await sendDirectNotification({
    notificationId: `platform-admin-mfa:${userId}:${Date.now()}`,
    title: "Your OpenWind platform admin verification code",
    body: `Your verification code is ${code}. It expires in 10 minutes. If you did not request this, contact your OpenWind administrator.`,
    recipients: [{ userId, email }],
  });

  logger.info({ userId }, "platform-admin-mfa: code sent");
}

/**
 * Verifies a submitted code against the stored hash. A correct code consumes it (deletes the
 * otp/attempts keys) and sets the verified flag; an incorrect code increments the attempt
 * counter and, past MAX_VERIFY_ATTEMPTS, invalidates the code outright (the admin must request
 * a new one) rather than allowing unlimited guesses within the 10-minute window.
 */
export async function verifyMfaCode(
  userId: string,
  submittedCode: string,
): Promise<boolean> {
  const redis = getRedis();
  const storedHash = await redis.get(otpKey(userId));
  if (!storedHash) return false;

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
    await redis.expire(attemptsKey(userId), OTP_TTL_SECONDS);
  }
  if (attempts > MAX_VERIFY_ATTEMPTS) {
    await redis.del(otpKey(userId), attemptsKey(userId));
    logger.warn({ userId }, "platform-admin-mfa: max verify attempts exceeded");
    return false;
  }

  // Constant-time comparison -- both are sha256 hex digests, always 64 bytes, so this never
  // takes the length-mismatch branch in practice; timingSafeEqual still requires equal-length
  // buffers, hence the explicit check first.
  const submittedHash = Buffer.from(hashCode(submittedCode));
  const storedHashBuf = Buffer.from(storedHash);
  if (
    submittedHash.length !== storedHashBuf.length ||
    !timingSafeEqual(submittedHash, storedHashBuf)
  ) {
    return false;
  }

  await redis.del(otpKey(userId), attemptsKey(userId));
  await redis.set(verifiedKey(userId), "1", "EX", VERIFIED_TTL_SECONDS);
  logger.info({ userId }, "platform-admin-mfa: verified");
  return true;
}

/** Fails closed: a Redis timeout/error denies access, never grants it. */
export async function isMfaVerified(userId: string): Promise<boolean> {
  return withRedisTimeout(
    async () => (await getRedis().get(verifiedKey(userId))) !== null,
    false,
    { userId, op: "platform-admin-mfa:isMfaVerified" },
  );
}
