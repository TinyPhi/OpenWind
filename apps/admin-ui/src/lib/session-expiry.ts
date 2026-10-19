import { userManager } from "../authProvider.js";
import { emitSessionEnd } from "./session-events.js";
import { clearPlatformAdminMfaSession } from "./platform-admin-mfa-session.js";

const NOTICE_KEY = "ow:auth-notice";

/** Why a session was ended -- the login page tells the user which. */
export type SessionEndReason = "session_expired" | "trial_ended" | "suspended";

const REASONS: readonly SessionEndReason[] = [
  "session_expired",
  "trial_ended",
  "suspended",
];

// The auth layer's answers for a tenant that may no longer be used at all. Sign-in itself goes
// through Zitadel, which knows nothing about OpenWind trials, so without this the user lands in
// an app whose every request is refused.
const TENANT_ACCESS_ENDED: Readonly<Record<string, SessionEndReason>> = {
  TENANT_TRIAL_EXPIRED: "trial_ended",
  TENANT_SUSPENDED: "suspended",
};

const LOGIN_PATHS = new Set(["/login", "/platform-admin/login"]);

let redirecting = false;

/**
 * Whether a 401 that already survived the silent-refresh retry means the session itself
 * is gone. Only the auth layer's own "UNAUTHORIZED" (or a bare 401 with no code, e.g. from
 * a proxy) counts -- a route-level 401 like the platform-admin MFA "INVALID_CODE" is an
 * ordinary failure and must not log anyone out.
 */
export function isSessionEndingUnauthorized(
  status: number,
  errorCode: string | undefined,
): boolean {
  return (
    status === 401 && (errorCode === undefined || errorCode === "UNAUTHORIZED")
  );
}

/**
 * The reason to end the session for a 403 that says the tenant itself is closed (trial over,
 * suspended), or null for any other 403 -- a forbidden action must not sign anyone out.
 */
export function tenantAccessEndedReason(
  status: number,
  errorCode: string | undefined,
): SessionEndReason | null {
  if (status !== 403 || errorCode === undefined) return null;
  return TENANT_ACCESS_ENDED[errorCode] ?? null;
}

/**
 * Ends the local session and hard-navigates to the matching login page, leaving a one-shot
 * notice (why) for GlobalErrorBanner to show there. A full page load (not a router navigate)
 * is deliberate: it drops every in-flight request and cached tenant state at once. Runs once,
 * however many requests fail together.
 */
export function endSessionAndRedirectToLogin(
  reason: SessionEndReason = "session_expired",
): void {
  if (redirecting) return;
  const path = window.location.pathname;
  if (LOGIN_PATHS.has(path) || path.startsWith("/auth/callback")) return;
  redirecting = true;

  emitSessionEnd();
  // The sign-in is over, so its platform-admin verification goes with it. The server can't be
  // told (it no longer accepts this session), so its marker lapses on its own; dropping the
  // token here leaves no copy in this browser that could be replayed until then.
  clearPlatformAdminMfaSession();
  try {
    window.sessionStorage.setItem(NOTICE_KEY, reason);
  } catch {
    // Storage blocked (private mode etc.): the redirect still happens, just without the notice.
  }
  const target = path.startsWith("/platform-admin")
    ? "/platform-admin/login"
    : "/login";
  void userManager
    .removeUser()
    .catch(() => undefined)
    .finally(() => {
      window.location.replace(target);
    });
}

/** Reads and clears the one-shot notice, so it shows exactly once. */
export function consumeSessionEndNotice(): SessionEndReason | null {
  try {
    const value = window.sessionStorage.getItem(NOTICE_KEY);
    if (value === null) return null;
    window.sessionStorage.removeItem(NOTICE_KEY);
    return REASONS.find((r) => r === value) ?? null;
  } catch {
    return null;
  }
}

export function resetSessionExpiryForTests(): void {
  redirecting = false;
}
